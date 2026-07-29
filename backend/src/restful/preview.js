import { InternalServerError } from './errors';
import { ProxyUtils } from '@/core/proxy-utils';
import { findByName } from '@/utils/database';
import { success, failed } from './response';
import download from '@/utils/download';
import { SUBS_KEY } from '@/constants';
import $ from '@/core/app';
import {
    handleIgnoreFailedRemoteSubError,
    notifyIgnoreFailedRemoteSubFallback,
    resolveIgnoreFailedRemoteSubMode,
    shouldFallbackIgnoreFailedRemoteSub,
    shouldNotifyIgnoreFailedRemoteSub,
} from '@/restful/ignore-failed-remote-sub';
import {
    prepareMihomoProfileContent,
    resolveFileRawContent,
} from '@/restful/sync';
import { normalizeClashYaml } from '@/core/proxy-utils/preprocessors';
import { maskAgeSecretInUrl } from '@/utils/age';
import { isMihomoConfigFile, normalizeFileConfig } from '@/utils/file-type';

function formatAgeSafeUrls(errors) {
    return Object.keys(errors).map(maskAgeSecretInUrl).join(', ');
}

export default function register($app) {
    $app.post('/api/preview/sub', compareSub);
    $app.post('/api/preview/collection', compareCollection);
    $app.post('/api/preview/file', previewFile);
}

async function previewFile(req, res) {
    try {
        const file = normalizeFileConfig(req.body);
        let content = '';
        if (isMihomoConfigFile(file)) {
            content = await prepareMihomoProfileContent(file, {
                notifyTitle: '馃實 Sub-Store 棰勮鏂囦欢澶辫触',
            });
        } else {
            content = await resolveFileRawContent(file, {
                notifyTitle: '馃實 Sub-Store 棰勮鏂囦欢澶辫触',
            });
        }
        // parse proxies
        const files = (Array.isArray(content) ? content : [content]).flat();
        let filesContent = files
            .filter((i) => i != null && i !== '')
            .join('\n');

        // apply processors
        const processed =
            Array.isArray(file.process) && file.process.length > 0
                ? await ProxyUtils.process(
                      { $files: files, $content: filesContent, $file: file },
                      file.process,
                  )
                : { $content: filesContent, $files: files };

        // produce
        success(res, {
            original: filesContent,
            processed: normalizeClashYaml(processed?.$content ?? ''),
        });
    } catch (err) {
        $.error(err.message ?? err);
        failed(
            res,
            new InternalServerError(
                `INTERNAL_SERVER_ERROR`,
                `Failed to preview file`,
                `Reason: ${err.message ?? err}`,
            ),
        );
    }
}

async function compareSub(req, res) {
    const sub = req.body;
    const mode = resolveIgnoreFailedRemoteSubMode(sub.ignoreFailedRemoteSub);

    try {
        const target = req.query.target || 'JSON';
        let content;
        let sourceRaw;
        if (
            sub.source === 'local' &&
            !['localFirst', 'remoteFirst'].includes(sub.mergeSources)
        ) {
            content = sub.content;
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
                                sub.ua,
                                undefined,
                                sub.proxy,
                                undefined,
                                undefined,
                                undefined,
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
            content = downloaded.map((i) => i.result ?? i);
            sourceRaw = downloaded.map((i) => i.raw ?? i);

            if (Object.keys(errors).length > 0) {
                const message = `璁㈤槄 ${
                    sub.name
                } 鐨勮繙绋嬭闃?${formatAgeSafeUrls(
                    errors,
                )} 鍙戠敓閿欒, 璇锋煡鐪嬫棩蹇梎;
                handleIgnoreFailedRemoteSubError({
                    mode,
                    message,
                    notify: () => {
                        $.notify(
                            `馃實 Sub-Store 棰勮璁㈤槄澶辫触`,
                            `鉂?${sub.name}`,
                            message,
                        );
                    },
                });
            }
            if (sub.mergeSources === 'localFirst') {
                content.unshift(sub.content);
                sourceRaw.unshift(sub.content);
            } else if (sub.mergeSources === 'remoteFirst') {
                content.push(sub.content);
                sourceRaw.push(sub.content);
            }
        }
        // parse proxies
        const original = (Array.isArray(content) ? content : [content])
            .map((i) => ProxyUtils.parse(i))
            .flat();

        // add id
        original.forEach((proxy, i) => {
            proxy.id = i;
            proxy._subName = sub.name;
            proxy._subDisplayName = sub.displayName;
        });

        // apply processors
        const processed = await ProxyUtils.process(
            original,
            sub.process || [],
            target,
            { [sub.name]: sub },
            undefined,
            sourceRaw,
        );

        // produce
        success(res, { original, processed });
    } catch (err) {
        if (shouldFallbackIgnoreFailedRemoteSub(mode)) {
            notifyIgnoreFailedRemoteSubFallback({
                mode,
                error: err,
                notify: (error) => {
                    $.notify(
                        `馃實 Sub-Store 棰勮璁㈤槄澶辫触`,
                        `鉂?${sub.name}`,
                        `馃 鍘熷洜锛?{error.message ?? error}`,
                    );
                },
            });
            $.error(
                `璁㈤槄 ${sub.name} 棰勮鍚敤鍏滃簳鍚庤繑鍥炵┖缁撴灉: ${
                    err.message ?? err
                }`,
            );
            success(res, { original: [], processed: [] });
            return;
        }

        $.error(err.message ?? err);
        failed(
            res,
            new InternalServerError(
                `INTERNAL_SERVER_ERROR`,
                `Failed to preview subscription`,
                `Reason: ${err.message ?? err}`,
            ),
        );
    }
}

async function compareCollection(req, res) {
    const collection = req.body;
    const collectionMode = resolveIgnoreFailedRemoteSubMode(
        collection.ignoreFailedRemoteSub,
    );

    try {
        const allSubs = $.read(SUBS_KEY);
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
        const results = {};
        const errors = {};
        const rawResults = {};
        await Promise.all(
            subnames.map(async (name) => {
                const sub = findByName(allSubs, name);
                const subMode = resolveIgnoreFailedRemoteSubMode(
                    sub.ignoreFailedRemoteSub,
                );
                try {
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
                                            sub.ua,
                                            undefined,
                                            sub.proxy,
                                            undefined,
                                            undefined,
                                            undefined,
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
                                        `馃實 Sub-Store 棰勮璁㈤槄澶辫触`,
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
                        proxy._collectionDisplayName = collection.displayName;
                    });

                    // apply processors
                    const currentRaw = Array.isArray(sourceRaw)
                        ? sourceRaw
                        : [sourceRaw];
                    currentProxies = await ProxyUtils.process(
                        currentProxies,
                        sub.process || [],
                        'JSON',
                        { [sub.name]: sub, _collection: collection },
                        undefined,
                        currentRaw,
                    );
                    results[name] = currentProxies;
                    rawResults[name] = currentRaw;
                } catch (err) {
                    if (shouldFallbackIgnoreFailedRemoteSub(subMode)) {
                        notifyIgnoreFailedRemoteSubFallback({
                            mode: subMode,
                            error: err,
                            notify: (error) => {
                                $.notify(
                                    `馃實 Sub-Store 棰勮璁㈤槄澶辫触`,
                                    `鉂?${sub.name}`,
                                    `馃 鍘熷洜锛?{error.message ?? error}`,
                                );
                            },
                        });
                        $.error(
                            `璁㈤槄 ${sub.name} 鍦ㄧ粍鍚堣闃呴瑙堜腑鍚敤鍏滃簳鍚庤繑鍥炵┖缁撴灉: ${
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
                        `鉂?澶勭悊缁勫悎璁㈤槄 ${collection.name} 涓殑瀛愯闃? ${sub.name} 鏃跺嚭鐜伴敊璇細${err}锛乣,
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
                    `馃實 Sub-Store 棰勮缁勫悎璁㈤槄澶辫触`,
                    `鉂?${collection.name}`,
                    message,
                );
            };
            const hasProcessedSubscriptions = Object.keys(results).length > 0;
            if (
                hasProcessedSubscriptions &&
                shouldFallbackIgnoreFailedRemoteSub(collectionMode)
            ) {
                Object.keys(errors).forEach((name) => {
                    rawResults[name] = [];
                });
                if (shouldNotifyIgnoreFailedRemoteSub(collectionMode)) {
                    notify();
                }
            } else {
                handleIgnoreFailedRemoteSubError({
                    mode: collectionMode,
                    message,
                    notify,
                });
            }
        }
        // merge proxies with the original order
        const original = Array.prototype.concat.apply(
            [],
            subnames.map((name) => results[name] || []),
        );

        original.forEach((proxy, i) => {
            proxy.id = i;
            proxy._collectionName = collection.name;
            proxy._collectionDisplayName = collection.displayName;
        });

        const processed = await ProxyUtils.process(
            original,
            collection.process || [],
            'JSON',
            { _collection: collection },
            undefined,
            rawResults,
        );

        success(res, { original, processed });
    } catch (err) {
        if (shouldFallbackIgnoreFailedRemoteSub(collectionMode)) {
            notifyIgnoreFailedRemoteSubFallback({
                mode: collectionMode,
                error: err,
                notify: (error) => {
                    $.notify(
                        `馃實 Sub-Store 棰勮缁勫悎璁㈤槄澶辫触`,
                        `鉂?${collection.name}`,
                        `馃 鍘熷洜锛?{error.message ?? error}`,
                    );
                },
            });
            $.error(
                `缁勫悎璁㈤槄 ${collection.name} 棰勮鍚敤鍏滃簳鍚庤繑鍥炵┖缁撴灉: ${
                    err.message ?? err
                }`,
            );
            success(res, { original: [], processed: [] });
            return;
        }

        $.error(err.message ?? err);
        failed(
            res,
            new InternalServerError(
                `INTERNAL_SERVER_ERROR`,
                `Failed to preview collection`,
                `Reason: ${err.message ?? err}`,
            ),
        );
    }
}
