import $ from '@/core/app';
import {
    ARTIFACTS_KEY,
    COLLECTIONS_KEY,
    RULES_KEY,
    SUBS_KEY,
    FILES_KEY,
    SETTINGS_KEY,
} from '@/constants';
import { failed, success } from '@/restful/response';
import { InternalServerError, ResourceNotFoundError } from '@/restful/errors';
import {
    formatArtifactLogName,
    shouldSyncArtifactInGlobalCron,
} from '@/utils/artifact-cron';
import { findByName, updateByName } from '@/utils/database';
import download from '@/utils/download';
import { ProxyUtils } from '@/core/proxy-utils';
import { RuleUtils } from '@/core/rule-utils';
import {
    normalizeArtifactSyncBatchSize,
    syncToGist,
} from '@/restful/artifacts';
import {
    buildEmptySubscriptionOutput,
    handleIgnoreFailedRemoteSubError,
    notifyIgnoreFailedRemoteSubFallback,
    resolveIgnoreFailedRemoteSubMode,
    shouldFallbackIgnoreFailedRemoteSub,
    shouldNotifyIgnoreFailedRemoteSub,
} from '@/restful/ignore-failed-remote-sub';
import { normalizeClashYaml } from '@/core/proxy-utils/preprocessors';
import { applyAgeOutputEncryption } from '@/restful/age-output';
import { maskAgeSecretInUrl } from '@/utils/age';
import { isMihomoConfigFile, normalizeFileConfig } from '@/utils/file-type';

export default function register($app) {
    // Initialization
    if (!$.read(ARTIFACTS_KEY)) $.write({}, ARTIFACTS_KEY);

    // sync all artifacts
    $app.get('/api/sync/artifacts', syncAllArtifacts);
    $app.get('/api/sync/artifact/:name', syncArtifact);
}

const MERGE_SOURCE_MODES = ['localFirst', 'remoteFirst'];
const MIHOMO_PROFILE_FILE_SOURCE_TYPES = ['local', 'remote'];
const MIHOMO_CONFIG_SOURCE_TYPES = [
    'collection',
    'local',
    'none',
    'remote',
    'subscription',
];

function formatAgeSafeUrls(errors) {
    return Object.keys(errors).map(maskAgeSecretInUrl).join(', ');
}

function isMergeSourceMode(mode) {
    return MERGE_SOURCE_MODES.includes(mode);
}

function normalizeFileSourceType(file) {
    if (isMihomoConfigFile(file)) {
        return normalizeMihomoConfigSourceType(file);
    }
    return file?.source;
}

function normalizeMihomoConfigSourceType(file) {
    return MIHOMO_CONFIG_SOURCE_TYPES.includes(file?.sourceType)
        ? file.sourceType
        : 'collection';
}

function normalizeRawFiles(raw) {
    return (Array.isArray(raw) ? raw : [raw]).flat();
}

function joinRawFileContent(raw) {
    return normalizeRawFiles(raw)
        .filter((i) => i != null && i !== '')
        .join('\n');
}

function resolveFileIgnoreFailedRemoteFile(file, ignoreFailedRemoteFile) {
    if (ignoreFailedRemoteFile != null && ignoreFailedRemoteFile !== '') {
        return ignoreFailedRemoteFile;
    }
    return file.ignoreFailedRemoteFile;
}

async function downloadFileSources({
    file,
    sourceUrl,
    ua,
    proxy,
    noCache,
    ignoreFailedRemoteFile,
    notifyTitle = '馃實 Sub-Store 澶勭悊鏂囦欢澶辫触',
}) {
    const errors = {};
    const urls = `${sourceUrl || ''}`
        .split(/[\r\n]+/)
        .map((i) => i.trim())
        .filter((i) => i.length);
    if (urls.length === 0) {
        throw new Error(`鏂囦欢 ${file.name} 鏈厤缃繙绋嬫枃浠?URL`);
    }

    const raw = await Promise.all(
        urls.map(async (url) => {
            try {
                return await download(
                    url,
                    ua || file.ua,
                    undefined,
                    file.proxy || proxy,
                    undefined,
                    undefined,
                    noCache,
                    undefined,
                    { relayNodeId: file.relayNodeId },
                );
            } catch (err) {
                errors[url] = err;
                $.error(
                    `鏂囦欢 ${file.name} 鐨勮繙绋嬫枃浠?${maskAgeSecretInUrl(
                        url,
                    )} 鍙戠敓閿欒: ${err}`,
                );
                return '';
            }
        }),
    );

    const fileIgnoreFailedRemoteFile = resolveFileIgnoreFailedRemoteFile(
        file,
        ignoreFailedRemoteFile,
    );

    if (Object.keys(errors).length > 0) {
        if (!fileIgnoreFailedRemoteFile) {
            throw new Error(
                `鏂囦欢 ${file.name} 鐨勮繙绋嬫枃浠?${formatAgeSafeUrls(
                    errors,
                )} 鍙戠敓閿欒, 璇锋煡鐪嬫棩蹇梎,
            );
        } else if (fileIgnoreFailedRemoteFile === 'enabled') {
            $.notify(
                notifyTitle,
                `鉂?${file.name}`,
                `杩滅▼鏂囦欢 ${formatAgeSafeUrls(errors)} 鍙戠敓閿欒, 璇锋煡鐪嬫棩蹇梎,
            );
        }
    }

    return raw;
}

async function resolveFileRawContent(
    file,
    {
        url,
        ua,
        content,
        mergeSources,
        ignoreFailedRemoteFile,
        proxy,
        noCache,
        notifyTitle,
    } = {},
) {
    if (content && !isMergeSourceMode(mergeSources)) {
        return content;
    }

    if (url) {
        const raw = await downloadFileSources({
            file,
            sourceUrl: url,
            ua,
            proxy,
            noCache,
            ignoreFailedRemoteFile,
            notifyTitle,
        });
        if (mergeSources === 'localFirst') {
            raw.unshift(content);
        } else if (mergeSources === 'remoteFirst') {
            raw.push(content);
        }
        return raw;
    }

    if (
        normalizeFileSourceType(file) === 'local' &&
        !isMergeSourceMode(file.mergeSources)
    ) {
        return file.content;
    }

    const raw = await downloadFileSources({
        file,
        sourceUrl: file.url,
        ua,
        proxy,
        noCache,
        ignoreFailedRemoteFile,
        notifyTitle,
    });

    if (file.mergeSources === 'localFirst') {
        raw.unshift(file.content);
    } else if (file.mergeSources === 'remoteFirst') {
        raw.push(file.content);
    }

    return raw;
}

async function prepareMihomoProfileContent(file, sourceOptions = {}) {
    const config = {};
    const sourceType = normalizeMihomoConfigSourceType(file);
    if (sourceType === 'none') {
        return ProxyUtils.yaml.safeDump(config);
    }

    if (MIHOMO_PROFILE_FILE_SOURCE_TYPES.includes(sourceType)) {
        const raw = await resolveFileRawContent(file, sourceOptions);
        if (file?.mode !== 'proxy') {
            return joinRawFileContent(raw);
        }

        const proxies = normalizeRawFiles(raw)
            .map((i) => ProxyUtils.parse(i))
            .flat();
        if (proxies.length === 0) {
            throw new Error(`鏂囦欢 ${file.name} 涓笉鍚湁鏁堣妭鐐筦);
        }
        config.proxies = ProxyUtils.produce(
            proxies,
            'mihomo',
            'internal',
            {
                'delete-underscore-fields': true,
                'include-unsupported-proxy': file?.includeUnsupportedProxy,
            },
        );
    } else {
        config.proxies = await produceArtifact({
            type: sourceType,
            name: file?.sourceName,
            platform: 'mihomo',
            produceType: 'internal',
            produceOpts: {
                'delete-underscore-fields': true,
                'include-unsupported-proxy': file?.includeUnsupportedProxy,
            },
        });
    }
    return ProxyUtils.yaml.safeDump(config);
}

async function produceArtifact({
    type,
    name,
    platform,
    url,
    ua,
    content,
    mergeSources,
    ignoreFailedRemoteSub,
    ignoreFailedRemoteFile,
    produceType,
    produceOpts = {},
    subscription,
    file: sourceFile,
    awaitCustomCache,
    $options,
    proxy,
    noCache,
    all,
}) {
    platform = platform || 'JSON';

    if (['subscription', 'sub'].includes(type)) {
        let sub;
        if (name) {
            const allSubs = $.read(SUBS_KEY);
            sub = findByName(allSubs, name);
            if (!sub) throw new Error(`鎵句笉鍒拌闃?${name}`);
        } else if (subscription) {
            sub = subscription;
        } else {
            throw new Error('鏈彁渚涜闃呭悕绉版垨璁㈤槄鏁版嵁');
        }
        const subIgnoreFailedRemoteSub = resolveIgnoreFailedRemoteSubMode(
            ignoreFailedRemoteSub,
            sub.ignoreFailedRemoteSub,
        );

        try {
            let raw;
            let sourceRaw;
            if (
                content &&
                !['localFirst', 'remoteFirst'].includes(mergeSources)
            ) {
                raw = content;
                sourceRaw = content;
            } else if (url) {
                const errors = {};
                const downloaded = await Promise.all(
                    url
                        .split(/[\r\n]+/)
                        .map((i) => i.trim())
                        .filter((i) => i.length)
                        .map(async (url) => {
                            try {
                                return await download(
                                    url,
                                    ua || sub.ua,
                                    undefined,
                                    proxy || sub.proxy,
                                    undefined,
                                    awaitCustomCache,
                                    noCache || sub.noCache,
                                    true,
{ returnRaw: true, relayNodeId: sub.relayNodeId },
                                );
                            } catch (err) {
                                errors[url] = err;
                                $.error(
                                    `璁㈤槄 ${sub.name} 鐨勮繙绋嬭闃?${maskAgeSecretInUrl(
                                        url,
                                    )} 鍙戠敓閿欒: ${err}`,
                                );
                                return '';
                            }
                        }),
                );
                raw = downloaded.map((i) => i.result ?? i);
                sourceRaw = downloaded.map((i) => i.raw ?? i);

                if (Object.keys(errors).length > 0) {
                    const message = `璁㈤槄 ${
                        sub.name
                    } 鐨勮繙绋嬭闃?${formatAgeSafeUrls(
                        errors,
                    )} 鍙戠敓閿欒, 璇锋煡鐪嬫棩蹇梎;
                    handleIgnoreFailedRemoteSubError({
                        mode: subIgnoreFailedRemoteSub,
                        message,
                        notify: () => {
                            $.notify(
                                `馃實 Sub-Store 澶勭悊璁㈤槄澶辫触`,
                                `鉂?${sub.name}`,
                                message,
                            );
                        },
                    });
                }
                if (mergeSources === 'localFirst') {
                    raw.unshift(content);
                    sourceRaw.unshift(content);
                } else if (mergeSources === 'remoteFirst') {
                    raw.push(content);
                    sourceRaw.push(content);
                }
            } else if (
                sub.source === 'local' &&
                !['localFirst', 'remoteFirst'].includes(sub.mergeSources)
            ) {
                raw = sub.content;
                sourceRaw = sub.content;
            } else {
                const errors = {};
                const downloaded = await Promise.all(
                    sub.url
                        .split(/[\r\n]+/)
                        .map((i) => i.trim())
                        .filter((i) => i.length)
                        .map(async (url) => {
                            try {
                                return await download(
                                    url,
                                    ua || sub.ua,
                                    undefined,
                                    proxy || sub.proxy,
                                    undefined,
                                    awaitCustomCache,
                                    noCache || sub.noCache,
                                    true,
{ returnRaw: true, relayNodeId: sub.relayNodeId },
                                );
                            } catch (err) {
                                errors[url] = err;
                                $.error(
                                    `璁㈤槄 ${sub.name} 鐨勮繙绋嬭闃?${maskAgeSecretInUrl(
                                        url,
                                    )} 鍙戠敓閿欒: ${err}`,
                                );
                                return '';
                            }
                        }),
                );
                raw = downloaded.map((i) => i.result ?? i);
                sourceRaw = downloaded.map((i) => i.raw ?? i);

                if (Object.keys(errors).length > 0) {
                    const message = `璁㈤槄 ${
                        sub.name
                    } 鐨勮繙绋嬭闃?${formatAgeSafeUrls(
                        errors,
                    )} 鍙戠敓閿欒, 璇锋煡鐪嬫棩蹇梎;
                    handleIgnoreFailedRemoteSubError({
                        mode: subIgnoreFailedRemoteSub,
                        message,
                        notify: () => {
                            $.notify(
                                `馃實 Sub-Store 澶勭悊璁㈤槄澶辫触`,
                                `鉂?${sub.name}`,
                                message,
                            );
                        },
                    });
                }
                if (sub.mergeSources === 'localFirst') {
                    raw.unshift(sub.content);
                    sourceRaw.unshift(sub.content);
                } else if (sub.mergeSources === 'remoteFirst') {
                    raw.push(sub.content);
                    sourceRaw.push(sub.content);
                }
            }
            if (produceType === 'raw') {
                return JSON.stringify((Array.isArray(raw) ? raw : [raw]).flat());
            }
            // parse proxies
            let proxies = (Array.isArray(raw) ? raw : [raw])
                .map((i) => ProxyUtils.parse(i))
                .flat();

            proxies.forEach((proxy) => {
                proxy._subName = sub.name;
                proxy._subDisplayName = sub.displayName;
            });
            // apply processors
            proxies = await ProxyUtils.process(
                proxies,
                sub.process || [],
                platform,
                { [sub.name]: sub },
                $options,
                sourceRaw,
            );
            if (proxies.length === 0) {
                throw new Error(`璁㈤槄 ${name} 涓笉鍚湁鏁堣妭鐐筦);
            }
            // check duplicate
            const exist = {};
            for (const proxy of proxies) {
                if (exist[proxy.name]) {
                    $.notify(
                        '馃實 Sub-Store',
                        `鈿狅笍 璁㈤槄 ${name} 鍖呭惈閲嶅鑺傜偣 ${proxy.name}锛乣,
                        '璇蜂粩缁嗘娴嬮厤缃紒',
                        {
                            'media-url':
                                'https://cdn3.iconfinder.com/data/icons/seo-outline-1/512/25_code_program_programming_develop_bug_search_developer-512.png',
                        },
                    );
                    break;
                }
                exist[proxy.name] = true;
            }
            // produce
            return ProxyUtils.produce(
                proxies,
                platform,
                produceType,
                produceOpts,
            );
        } catch (err) {
            if (!shouldFallbackIgnoreFailedRemoteSub(subIgnoreFailedRemoteSub)) {
                throw err;
            }

            notifyIgnoreFailedRemoteSubFallback({
                mode: subIgnoreFailedRemoteSub,
                error: err,
                notify: (error) => {
                    $.notify(
                        `馃實 Sub-Store 澶勭悊璁㈤槄澶辫触`,
                        `鉂?${sub.name}`,
                        `馃 鍘熷洜锛?{error.message ?? error}`,
                    );
                },
            });
            $.error(
                `璁㈤槄 ${sub.name} 鍚敤鍏滃簳鍚庤繑鍥炵┖缁撴灉: ${err.message ?? err}`,
            );

            return buildEmptySubscriptionOutput({
                platform,
                produceType,
                produceOpts,
            });
        }
    } else if (['collection', 'col'].includes(type)) {
        const allSubs = $.read(SUBS_KEY);
        const allCols = $.read(COLLECTIONS_KEY);
        const collection = findByName(allCols, name);
        if (!collection) throw new Error(`鎵句笉鍒扮粍鍚堣闃?${name}`);
        const subnames = [...collection.subscriptions];
        let subscriptionTags = collection.subscriptionTags;
        if (Array.isArray(subscriptionTags) && subscriptionTags.length > 0) {
            allSubs.forEach((sub) => {
                if (
                    Array.isArray(sub.tag) &&
                    sub.tag.length > 0 &&
                    !subnames.includes(sub.name) &&
                    sub.tag.some((tag) => subscriptionTags.includes(tag))
                ) {
                    subnames.push(sub.name);
                }
            });
        }
        const collectionIgnoreFailedRemoteSub = resolveIgnoreFailedRemoteSubMode(
            ignoreFailedRemoteSub,
            collection.ignoreFailedRemoteSub,
        );

        try {
            const results = {};
            const errors = {};
            const rawResults = {};
            let processed = 0;

            await Promise.all(
                subnames.map(async (name) => {
                    const sub = findByName(allSubs, name);
                    const subMode = resolveIgnoreFailedRemoteSubMode(
                        sub.ignoreFailedRemoteSub,
                    );
                    const passThroughUA = sub.passThroughUA;
                    let reqUA = sub.ua;
                    if (passThroughUA) {
                        $.info(
                            `璁㈤槄寮€鍚簡閫忎紶 User-Agent, 浣跨敤璇锋眰鐨?User-Agent: ${ua}`,
                        );
                        reqUA = ua;
                    }
                    try {
                        $.info(`姝ｅ湪澶勭悊瀛愯闃咃細${sub.name}...`);
                        let raw;
                        let sourceRaw;
                        if (
                            sub.source === 'local' &&
                            !['localFirst', 'remoteFirst'].includes(
                                sub.mergeSources,
                            )
                        ) {
                            raw = sub.content;
                            sourceRaw = sub.content;
                        } else {
                            const errors = {};
                            const downloaded = await Promise.all(
                                sub.url
                                    .split(/[\r\n]+/)
                                    .map((i) => i.trim())
                                    .filter((i) => i.length)
                                    .map(async (url) => {
                                        try {
                                            return await download(
                                                url,
                                                reqUA,
                                                undefined,
                                                proxy ||
                                                    sub.proxy ||
                                                    collection.proxy,
                                                undefined,
                                                undefined,
                                                noCache || sub.noCache,
                                                true,
{ returnRaw: true, relayNodeId: sub.relayNodeId },
                                            );
                                        } catch (err) {
                                            errors[url] = err;
                                            $.error(
                                                `璁㈤槄 ${
                                                    sub.name
                                                } 鐨勮繙绋嬭闃?${maskAgeSecretInUrl(
                                                    url,
                                                )} 鍙戠敓閿欒: ${err}`,
                                            );
                                            return '';
                                        }
                                    }),
                            );
                            raw = downloaded.map((i) => i.result ?? i);
                            sourceRaw = downloaded.map((i) => i.raw ?? i);

                            if (Object.keys(errors).length > 0) {
                                const message = `璁㈤槄 ${
                                    sub.name
                                } 鐨勮繙绋嬭闃?${formatAgeSafeUrls(
                                    errors,
                                )} 鍙戠敓閿欒, 璇锋煡鐪嬫棩蹇梎;
                                handleIgnoreFailedRemoteSubError({
                                    mode: subMode,
                                    message,
                                    notify: () => {
                                        $.notify(
                                            `馃實 Sub-Store 澶勭悊璁㈤槄澶辫触`,
                                            `鉂?${sub.name}`,
                                            message,
                                        );
                                    },
                                });
                            }
                            if (sub.mergeSources === 'localFirst') {
                                raw.unshift(sub.content);
                                sourceRaw.unshift(sub.content);
                            } else if (sub.mergeSources === 'remoteFirst') {
                                raw.push(sub.content);
                                sourceRaw.push(sub.content);
                            }
                        }
                        // parse proxies
                        let currentProxies = (Array.isArray(raw) ? raw : [raw])
                            .map((i) => ProxyUtils.parse(i))
                            .flat();

                        currentProxies.forEach((proxy) => {
                            proxy._subName = sub.name;
                            proxy._subDisplayName = sub.displayName;
                            proxy._collectionName = collection.name;
                            proxy._collectionDisplayName =
                                collection.displayName;
                        });

                        // apply processors
                        const currentRaw = Array.isArray(sourceRaw)
                            ? sourceRaw
                            : [sourceRaw];
                        currentProxies = await ProxyUtils.process(
                            currentProxies,
                            sub.process || [],
                            platform,
                            {
                                [sub.name]: sub,
                                _collection: collection,
                                $options,
                            },
                            undefined,
                            currentRaw,
                        );
                        results[name] = currentProxies;
                        rawResults[name] = currentRaw;
                        processed++;
                        $.info(
                            `鉁?瀛愯闃咃細${sub.name}鍔犺浇鎴愬姛锛岃繘搴?-${
                                100 * (processed / subnames.length).toFixed(1)
                            }% `,
                        );
                    } catch (err) {
                        processed++;

                        if (shouldFallbackIgnoreFailedRemoteSub(subMode)) {
                            notifyIgnoreFailedRemoteSubFallback({
                                mode: subMode,
                                error: err,
                                notify: (error) => {
                                    $.notify(
                                        `馃實 Sub-Store 澶勭悊璁㈤槄澶辫触`,
                                        `鉂?${sub.name}`,
                                        `馃 鍘熷洜锛?{error.message ?? error}`,
                                    );
                                },
                            });
                            $.error(
                                `璁㈤槄 ${sub.name} 鍦ㄧ粍鍚堣闃呭鐞嗕腑鍚敤鍏滃簳鍚庤繑鍥炵┖缁撴灉: ${
                                    err.message ?? err
                                }`,
                            );
                            results[name] = [];
                            rawResults[name] = [];
                            return;
                        }

                        errors[name] = err;
                        rawResults[name] = undefined;
                        $.error(
                            `鉂?澶勭悊缁勫悎璁㈤槄涓殑瀛愯闃? ${
                                sub.name
                            }鏃跺嚭鐜伴敊璇細${err}锛佽繘搴?-${
                                100 * (processed / subnames.length).toFixed(1)
                            }%`,
                        );
                    }
                }),
            );

            if (Object.keys(errors).length > 0) {
                const message = `缁勫悎璁㈤槄 ${collection.name} 鐨勫瓙璁㈤槄 ${Object.keys(
                    errors,
                ).join(', ')} 鍙戠敓閿欒, 璇锋煡鐪嬫棩蹇梎;
                const notify = () => {
                    $.notify(
                        `馃實 Sub-Store 澶勭悊缁勫悎璁㈤槄澶辫触`,
                        `鉂?${collection.name}`,
                        message,
                    );
                };
                const hasProcessedSubscriptions =
                    Object.keys(results).length > 0;
                if (
                    hasProcessedSubscriptions &&
                    shouldFallbackIgnoreFailedRemoteSub(
                        collectionIgnoreFailedRemoteSub,
                    )
                ) {
                    Object.keys(errors).forEach((name) => {
                        rawResults[name] = [];
                    });
                    if (
                        shouldNotifyIgnoreFailedRemoteSub(
                            collectionIgnoreFailedRemoteSub,
                        )
                    ) {
                        notify();
                    }
                } else {
                    handleIgnoreFailedRemoteSubError({
                        mode: collectionIgnoreFailedRemoteSub,
                        message,
                        notify,
                    });
                }
            }

            // merge proxies with the original order
            let proxies = Array.prototype.concat.apply(
                [],
                subnames.map((name) => results[name] || []),
            );

            proxies.forEach((proxy) => {
                proxy._collectionName = collection.name;
                proxy._collectionDisplayName = collection.displayName;
            });

            // apply own processors
            proxies = await ProxyUtils.process(
                proxies,
                collection.process || [],
                platform,
                { _collection: collection },
                $options,
                rawResults,
            );
            if (proxies.length === 0) {
                throw new Error(`缁勫悎璁㈤槄 ${name} 涓笉鍚湁鏁堣妭鐐筦);
            }
            // check duplicate
            const exist = {};
            for (const proxy of proxies) {
                if (exist[proxy.name]) {
                    $.notify(
                        '馃實 Sub-Store',
                        `鈿狅笍 缁勫悎璁㈤槄 ${name} 鍖呭惈閲嶅鑺傜偣 ${proxy.name}锛乣,
                        '璇蜂粩缁嗘娴嬮厤缃紒',
                        {
                            'media-url':
                                'https://cdn3.iconfinder.com/data/icons/seo-outline-1/512/25_code_program_programming_develop_bug_search_developer-512.png',
                        },
                    );
                    break;
                }
                exist[proxy.name] = true;
            }
            return ProxyUtils.produce(
                proxies,
                platform,
                produceType,
                produceOpts,
            );
        } catch (err) {
            if (
                !shouldFallbackIgnoreFailedRemoteSub(
                    collectionIgnoreFailedRemoteSub,
                )
            ) {
                throw err;
            }

            notifyIgnoreFailedRemoteSubFallback({
                mode: collectionIgnoreFailedRemoteSub,
                error: err,
                notify: (error) => {
                    $.notify(
                        `馃實 Sub-Store 澶勭悊缁勫悎璁㈤槄澶辫触`,
                        `鉂?${collection.name}`,
                        `馃 鍘熷洜锛?{error.message ?? error}`,
                    );
                },
            });
            $.error(
                `缁勫悎璁㈤槄 ${collection.name} 鍚敤鍏滃簳鍚庤繑鍥炵┖缁撴灉: ${
                    err.message ?? err
                }`,
            );

            return buildEmptySubscriptionOutput({
                platform,
                produceType,
                produceOpts,
            });
        }
    } else if (type === 'rule') {
        const allRules = $.read(RULES_KEY);
        const rule = findByName(allRules, name);
        if (!rule) throw new Error(`鎵句笉鍒拌鍒?${name}`);
        let rules = [];
        for (let i = 0; i < rule.urls.length; i++) {
            const url = rule.urls[i];
            $.info(
                `姝ｅ湪澶勭悊URL锛?{url}锛岃繘搴?-${
                    100 * ((i + 1) / rule.urls.length).toFixed(1)
                }% `,
            );
            try {
                const { body } = await download(url);
                const currentRules = RuleUtils.parse(body);
                rules = rules.concat(currentRules);
            } catch (err) {
                $.error(
                    `澶勭悊鍒嗘祦璁㈤槄涓殑URL: ${url}鏃跺嚭鐜伴敊璇細${err}! 璇ヨ闃呭凡琚烦杩囥€俙,
                );
            }
        }
        // remove duplicates
        rules = await RuleUtils.process(rules, [
            { type: 'Remove Duplicate Filter' },
        ]);
        // produce output
        return RuleUtils.produce(rules, platform);
    } else if (type === 'file') {
        const allFiles = $.read(FILES_KEY);
        const file = normalizeFileConfig(
            sourceFile || findByName(allFiles, name),
        );
        if (!file) throw new Error(`鎵句笉鍒版枃浠?${name}`);
        let raw = '';
        if (isMihomoConfigFile(file)) {
            raw = await prepareMihomoProfileContent(file, {
                url,
                ua,
                content,
                mergeSources,
                ignoreFailedRemoteFile,
                proxy,
                noCache,
            });
        } else {
            raw = await resolveFileRawContent(file, {
                url,
                ua,
                content,
                mergeSources,
                ignoreFailedRemoteFile,
                proxy,
                noCache,
            });
        }
        if (produceType === 'raw') {
            return JSON.stringify(normalizeRawFiles(raw));
        }
        const files = normalizeRawFiles(raw);
        let filesContent = joinRawFileContent(files);

        // apply processors
        const processed =
            Array.isArray(file.process) && file.process.length > 0
                ? await ProxyUtils.process(
                      {
                          $files: files,
                          $content: filesContent,
                          $options,
                          $file: file,
                      },
                      file.process,
                  )
                : { $content: filesContent, $files: files, $options };

        processed.$content = normalizeClashYaml(processed?.$content ?? '');

        return (all ? processed : processed?.$content) ?? '';
    }
}

function createArtifactUploadBatches(names, batchSize) {
    const batches = [];
    for (let index = 0; index < names.length; index += batchSize) {
        batches.push(names.slice(index, index + batchSize));
    }
    return batches;
}

function normalizeUploadResponseFiles(files) {
    if (Array.isArray(files)) {
        return {
            isGitLab: true,
            files: Object.fromEntries(files.map((item) => [item.path, item])),
        };
    }

    return {
        isGitLab: false,
        files: files || {},
    };
}

function logUploadResponse(body) {
    delete body.history;
    delete body.forks;
    delete body.owner;
    if (body.files) {
        Object.values(body.files).forEach((file) => {
            delete file.content;
        });
    }
    $.info('涓婁紶閰嶇疆鍝嶅簲:');
    $.info(JSON.stringify(body, null, 2));
}

function resolveArtifactUploadUrl(body, artifactName) {
    const { files, isGitLab } = normalizeUploadResponseFiles(body.files);
    const encodedName = encodeURIComponent(artifactName);
    const raw_url = files[encodedName]?.raw_url;
    const new_url = isGitLab
        ? raw_url
        : raw_url?.replace(/\/raw\/[^/]*\/(.*)/, '/raw/$1');
    $.info(
        `涓婁紶閰嶇疆瀹屾垚\n鏂囦欢鍒楄〃: ${Object.keys(files).join(
            ', ',
        )}\n褰撳墠鏂囦欢: ${encodedName}\n鍝嶅簲杩斿洖鐨勫師濮嬮摼鎺? ${raw_url}\n澶勭悊瀹岀殑鏂伴摼鎺? ${new_url}`,
    );
    return new_url;
}

function shouldUploadArtifact(artifact) {
    return artifact?.upload !== false;
}

function findArtifactSourceConfig(artifact) {
    if (!artifact?.source) return null;

    if (['subscription', 'sub'].includes(artifact.type)) {
        return findByName($.read(SUBS_KEY), artifact.source);
    }
    if (['collection', 'col'].includes(artifact.type)) {
        return findByName($.read(COLLECTIONS_KEY), artifact.source);
    }
    if (artifact.type === 'file') {
        return findByName($.read(FILES_KEY), artifact.source);
    }

    return null;
}

async function produceSyncArtifactOutput(artifact) {
    const useMihomoExternal = artifact.platform === 'SurgeMac';
    const output = await produceArtifact({
        type: artifact.type,
        name: artifact.source,
        platform: artifact.platform,
        produceOpts: {
            'include-unsupported-proxy': artifact.includeUnsupportedProxy,
            useMihomoExternal,
            prettyYaml: artifact.prettyYaml,
        },
    });

    return applyAgeOutputEncryption({
        body: output,
        configs: [artifact, findArtifactSourceConfig(artifact)],
    });
}

function markArtifactProducedWithoutUpload(artifact) {
    artifact.updated = new Date().getTime();
    delete artifact.url;
}

function patchArtifactSyncResult(name, patcher) {
    const latestArtifacts = $.read(ARTIFACTS_KEY);
    const currentArtifact = findByName(latestArtifacts, name);
    if (!currentArtifact) {
        $.info(`杩滅▼閰嶇疆 ${name} 宸蹭笉瀛樺湪, 璺宠繃鍚屾缁撴灉鍐欏叆`);
        return null;
    }

    const nextArtifact = patcher({ ...currentArtifact });
    updateByName(latestArtifacts, name, nextArtifact);
    $.write(latestArtifacts, ARTIFACTS_KEY);
    return nextArtifact;
}

async function uploadArtifactBatches({ allArtifacts, files, valid, invalid }) {
    const settings = $.read(SETTINGS_KEY) || {};
    const batchSize = normalizeArtifactSyncBatchSize(
        settings.artifactSyncBatchSize,
    );
    const uploadNames = valid.filter((name) => {
        const artifact = findByName(allArtifacts, name);
        return artifact && shouldUploadArtifact(artifact);
    });
    const batches = createArtifactUploadBatches(uploadNames, batchSize);
    const uploaded = [];

    if (uploadNames.length === 0) {
        $.info('娌℃湁闇€瑕佷笂浼犵殑鍚屾閰嶇疆');
        return uploaded;
    }

    $.info(
        `鍑嗗鍒嗘壒涓婁紶鍚屾閰嶇疆: 鍏?${uploadNames.length} 涓? 姣忔壒 ${batchSize} 涓? 鎵规鏁?${batches.length}`,
    );

    for (let index = 0; index < batches.length; index++) {
        const batchNames = batches[index];
        const batchFiles = Object.fromEntries(
            batchNames.map((name) => [
                encodeURIComponent(name),
                files[encodeURIComponent(name)],
            ]),
        );

        try {
            $.info(
                `姝ｅ湪涓婁紶绗?${index + 1}/${
                    batches.length
                } 鎵瑰悓姝ラ厤缃? ${batchNames.join(', ')}`,
            );
            const resp = await syncToGist(batchFiles);
            const body = JSON.parse(resp.body);
            logUploadResponse(body);

            for (const artifact of allArtifacts) {
                if (
                    artifact.sync &&
                    artifact.source &&
                    batchNames.includes(artifact.name)
                ) {
                    const newUrl = resolveArtifactUploadUrl(
                        body,
                        artifact.name,
                    );
                    if (newUrl) {
                        artifact.updated = new Date().getTime();
                        artifact.url = newUrl;
                        uploaded.push(artifact.name);
                    } else {
                        $.error(
                            `鍚屾閰嶇疆 ${artifact.name} 涓婁紶鎴愬姛浣嗗搷搴斾腑鏈壘鍒版枃浠堕摼鎺,
                        );
                        invalid.push(artifact.name);
                    }
                }
            }
        } catch (e) {
            $.error(
                `绗?${index + 1}/${
                    batches.length
                } 鎵瑰悓姝ラ厤缃笂浼犲け璐? ${batchNames.join(', ')}, 鍘熷洜: ${
                    e.message ?? e
                }`,
            );
            invalid.push(...batchNames);
        }
    }

    return uploaded;
}

function shouldSyncArtifact(artifact, { skipCronArtifacts = false } = {}) {
    return (
        artifact.sync &&
        artifact.source &&
        (!skipCronArtifacts || shouldSyncArtifactInGlobalCron(artifact))
    );
}

async function syncArtifacts(options = {}) {
    $.info('寮€濮嬪悓姝ユ墍鏈夎繙绋嬮厤缃?..');
    const allArtifacts = $.read(ARTIFACTS_KEY);
    const files = {};

    try {
        const valid = [];
        const invalid = [];
        const producedWithoutUpload = [];
        const allSubs = $.read(SUBS_KEY);
        const allCols = $.read(COLLECTIONS_KEY);
        const subNames = [];
        let enabledCount = 0;
        allArtifacts.map((artifact) => {
            if (shouldSyncArtifact(artifact, options)) {
                enabledCount++;
                if (artifact.type === 'subscription') {
                    const subName = artifact.source;
                    const sub = findByName(allSubs, subName);
                    if (sub && sub.url && !subNames.includes(subName)) {
                        subNames.push(subName);
                    }
                } else if (artifact.type === 'collection') {
                    const collection = findByName(allCols, artifact.source);
                    if (collection && Array.isArray(collection.subscriptions)) {
                        collection.subscriptions.map((subName) => {
                            const sub = findByName(allSubs, subName);
                            if (sub && sub.url && !subNames.includes(subName)) {
                                subNames.push(subName);
                            }
                        });
                    }
                }
            }
        });

        if (enabledCount === 0) {
            $.info(
                `闇€鍚屾鐨勯厤缃? ${enabledCount}, 鎬绘暟: ${allArtifacts.length}`,
            );
            return;
        }

        if (subNames.length > 0) {
            await Promise.all(
                subNames.map(async (subName) => {
                    try {
                        await produceArtifact({
                            type: 'subscription',
                            name: subName,
                            awaitCustomCache: true,
                        });
                    } catch (e) {
                        // $.error(`${e.message ?? e}`);
                    }
                }),
            );
        }

        await Promise.all(
            allArtifacts.map(async (artifact) => {
                try {
                    if (shouldSyncArtifact(artifact, options)) {
                        $.info(
                            `姝ｅ湪鍚屾浜戦厤缃細${formatArtifactLogName(
                                artifact,
                            )}...`,
                        );

                        const useMihomoExternal =
                            artifact.platform === 'SurgeMac';

                        if (useMihomoExternal) {
                            $.info(
                                `鎵嬪姩鎸囧畾浜?target 涓?SurgeMac, 灏嗕娇鐢?mihomo External`,
                            );
                        }

                        const output = await produceSyncArtifactOutput(
                            artifact,
                        );

                        // if (!output || output.length === 0)
                        //     throw new Error('璇ラ厤缃殑缁撴灉涓虹┖ 涓嶈繘琛屼笂浼?);

                        if (shouldUploadArtifact(artifact)) {
                            files[encodeURIComponent(artifact.name)] = {
                                content: output,
                            };
                            valid.push(artifact.name);
                        } else {
                            markArtifactProducedWithoutUpload(artifact);
                            producedWithoutUpload.push(artifact.name);
                        }
                    }
                } catch (e) {
                    $.error(
                        `鐢熸垚鍚屾閰嶇疆 ${formatArtifactLogName(
                            artifact,
                        )} 鍙戠敓閿欒: ${
                            e.message ?? e
                        }`,
                    );
                    invalid.push(artifact.name);
                }
            }),
        );

        const producedCount = valid.length + producedWithoutUpload.length;
        $.info(
            `${producedCount} 涓悓姝ラ厤缃敓鎴愭垚鍔? ${valid
                .concat(producedWithoutUpload)
                .join(', ')}`,
        );
        $.info(`${invalid.length} 涓悓姝ラ厤缃敓鎴愬け璐? ${invalid.join(', ')}`);
        if (producedWithoutUpload.length > 0) {
            $.info(
                `${
                    producedWithoutUpload.length
                } 涓悓姝ラ厤缃粎鐢熸垚鏈笂浼? ${producedWithoutUpload.join(', ')}`,
            );
        }

        if (producedCount === 0) {
            throw new Error(
                `鍚屾閰嶇疆 ${invalid.join(', ')} 鐢熸垚澶辫触 璇︽儏璇锋煡鐪嬫棩蹇梎,
            );
        }

        const uploaded = await uploadArtifactBatches({
            allArtifacts,
            files,
            valid,
            invalid,
        });

        $.write(allArtifacts, ARTIFACTS_KEY);
        $.info('鍚屾閰嶇疆鎵ц瀹屾垚');

        if (invalid.length > 0) {
            throw new Error(
                `鍚屾閰嶇疆鎴愬姛 ${
                    uploaded.length + producedWithoutUpload.length
                } 涓? 澶辫触 ${invalid.length} 涓? 璇︽儏璇锋煡鐪嬫棩蹇梎,
            );
        } else {
            $.info(
                `鍚屾閰嶇疆鎴愬姛 ${
                    uploaded.length + producedWithoutUpload.length
                } 涓猔,
            );
        }
    } catch (e) {
        $.error(`鍚屾閰嶇疆澶辫触锛屽師鍥狅細${e.message ?? e}`);
        throw e;
    }
}
async function syncAllArtifacts(_, res) {
    $.info('寮€濮嬪悓姝ユ墍鏈夎繙绋嬮厤缃?..');
    try {
        await syncArtifacts();
        success(res);
    } catch (e) {
        $.error(`鍚屾閰嶇疆澶辫触锛屽師鍥狅細${e.message ?? e}`);
        failed(
            res,
            new InternalServerError(
                `FAILED_TO_SYNC_ARTIFACTS`,
                `Failed to sync all artifacts`,
                `Reason: ${e.message ?? e}`,
            ),
        );
    }
}

async function syncArtifactItem(name) {
    const allArtifacts = $.read(ARTIFACTS_KEY);
    const artifact = findByName(allArtifacts, name);

    if (!artifact) {
        $.error(`鎵句笉鍒拌繙绋嬮厤缃?${name}`);
        throw new ResourceNotFoundError(
            'RESOURCE_NOT_FOUND',
            `鎵句笉鍒拌繙绋嬮厤缃?${name}`,
        );
    }

    if (!artifact.source) {
        $.error(`杩滅▼閰嶇疆 ${formatArtifactLogName(artifact)} 鏈缃潵婧恅);
        throw new ResourceNotFoundError(
            'RESOURCE_HAS_NO_SOURCE',
            `杩滅▼閰嶇疆 ${formatArtifactLogName(artifact)} 鏈缃潵婧恅,
        );
    }

    $.info(`寮€濮嬪悓姝ヨ繙绋嬮厤缃?${formatArtifactLogName(artifact)}...`);

    const useMihomoExternal = artifact.platform === 'SurgeMac';

    if (useMihomoExternal) {
        $.info(`鎵嬪姩鎸囧畾浜?target 涓?SurgeMac, 灏嗕娇鐢?mihomo External`);
    }
    const output = await produceSyncArtifactOutput(artifact);

    // if (!output || output.length === 0)
    //     throw new Error('璇ラ厤缃殑缁撴灉涓虹┖ 涓嶈繘琛屼笂浼?);
    if (!shouldUploadArtifact(artifact)) {
        $.info(
            `閰嶇疆 ${formatArtifactLogName(
                artifact,
            )} 宸插叧闂笂浼? 浠呮洿鏂版墽琛屾椂闂碻,
        );
        const updated = new Date().getTime();
        const patchedArtifact = patchArtifactSyncResult(
            name,
            (currentArtifact) => {
                currentArtifact.updated = updated;
                delete currentArtifact.url;
                return currentArtifact;
            },
        );
        if (patchedArtifact) return patchedArtifact;

        const fallbackArtifact = {
            ...artifact,
            updated,
        };
        delete fallbackArtifact.url;
        return fallbackArtifact;
    }

    $.info(
        `姝ｅ湪涓婁紶閰嶇疆锛?{formatArtifactLogName(artifact)}\n>>>${JSON.stringify(
            artifact,
            null,
            2,
        )}`,
    );
    const resp = await syncToGist({
        [encodeURIComponent(artifact.name)]: {
            content: output,
        },
    });
    const updated = new Date().getTime();
    const body = JSON.parse(resp.body);

    logUploadResponse(body);
    const new_url = resolveArtifactUploadUrl(body, artifact.name);
    const patchedArtifact = patchArtifactSyncResult(
        name,
        (currentArtifact) => ({
            ...currentArtifact,
            updated,
            url: new_url,
        }),
    );
    return (
        patchedArtifact || {
            ...artifact,
            updated,
            url: new_url,
        }
    );
}

async function syncArtifact(req, res) {
    let { name } = req.params;

    try {
        const artifact = await syncArtifactItem(name);
        success(res, artifact);
    } catch (err) {
        $.error(`杩滅▼閰嶇疆 ${name} 鍙戠敓閿欒: ${err.message ?? err}`);
        failed(
            res,
            err instanceof ResourceNotFoundError
                ? err
                : new InternalServerError(
                      `FAILED_TO_SYNC_ARTIFACT`,
                      `Failed to sync artifact ${name}`,
                      `Reason: ${err}`,
                  ),
            err instanceof ResourceNotFoundError ? 404 : undefined,
        );
    }
}

export {
    markArtifactProducedWithoutUpload,
    prepareMihomoProfileContent,
    produceArtifact,
    produceSyncArtifactOutput,
    resolveFileRawContent,
    shouldUploadArtifact,
    syncArtifactItem,
    syncArtifacts,
    uploadArtifactBatches,
};
