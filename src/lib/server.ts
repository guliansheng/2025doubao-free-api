import _ from 'lodash';

import Exception from './exceptions/Exception.ts';
import RequestModel from './request/Request.ts';
import Response from './response/Response.js';
import FailureBody from './response/FailureBody.ts';
import EX from './consts/exceptions.ts';
import logger from './logger.ts';
import config from './config.ts';
import util from './util.ts';

const isDenoServeEnv = typeof Deno !== "undefined" && typeof (Deno as any).serve === "function";

type RouteItem = {
    method: string;
    path: string;
    handler: Function;
};

type NodeServerDeps = {
    Koa: any;
    KoaRouter: any;
    koaRange: any;
    koaCors: any;
    koaBody: any;
};

let nodeServerDepsPromise: Promise<NodeServerDeps> | null = null;

async function loadNodeServerDeps(): Promise<NodeServerDeps> {
    if (!nodeServerDepsPromise) {
        nodeServerDepsPromise = Promise.all([
            import('koa'),
            import('koa-router'),
            import('koa-range'),
            import('koa2-cors'),
            import('koa-body')
        ]).then(([koa, router, range, cors, body]) => ({
            Koa: koa.default,
            KoaRouter: router.default,
            koaRange: range.default || range,
            koaCors: cors.default || cors,
            koaBody: body.default
        }));
    }
    return nodeServerDepsPromise;
}

class Server {

    app;
    router;
    fetchRoutes: RouteItem[] = [];
    isFetchServer: boolean;
    nodeReady = false;
    
    constructor() {
        this.isFetchServer = isDenoServeEnv;
        if (this.isFetchServer) {
            logger.success("Server initialized (Deno fetch handler)");
        }
    }

    async #ensureNodeApp() {
        if (this.isFetchServer || this.nodeReady) return;
        const { Koa, KoaRouter, koaRange, koaCors, koaBody } = await loadNodeServerDeps();
        this.app = new Koa();
        this.app.use(koaCors());
        // 范围请求支持
        this.app.use(koaRange);
        this.router = new KoaRouter({ prefix: config.service.urlPrefix });
        // 前置处理异常拦截
        this.app.use(async (ctx: any, next: Function) => {
            if(ctx.request.type === "application/xml" || ctx.request.type === "application/ssml+xml")
                ctx.req.headers["content-type"] = "text/xml";
            try { await next() }
            catch (err) {
                logger.error(err);
                const failureBody = new FailureBody(err);
                new Response(failureBody).injectTo(ctx);
            }
        });
        // 载荷解析器支持
        this.app.use(koaBody(_.clone(config.system.requestBody)));
        this.app.on("error", (err: any) => {
            // 忽略连接重试、中断、管道、取消错误
            if (["ECONNRESET", "ECONNABORTED", "EPIPE", "ECANCELED"].includes(err.code)) return;
            logger.error(err);
        });
        this.nodeReady = true;
        logger.success("Server initialized");
    }

    /**
     * 附加路由
     * 
     * @param routes 路由列表
     */
    async attachRoutes(routes: any[]) {
        if (this.isFetchServer) {
            this.fetchRoutes = this.#normalizeRoutes(routes);
            this.fetchRoutes.forEach(route => logger.info(`Route ${route.path} attached`));
            return;
        }
        await this.#ensureNodeApp();
        routes.forEach((route: any) => {
            const prefix = route.prefix || "";
            for (let method in route) {
                if(method === "prefix") continue;
                if (!_.isObject(route[method])) {
                    logger.warn(`Router ${prefix} ${method} invalid`);
                    continue;
                }
                for (let uri in route[method]) {
                    this.router[method](`${prefix}${uri}`, async ctx => {
                        const { request, response } = await this.#requestProcessing(ctx, route[method][uri]);
                        if(response != null && config.system.requestLog)
                            logger.info(`<- ${request.method} ${request.url} ${response.time - request.time}ms`);
                    });
                }
            }
            logger.info(`Route ${config.service.urlPrefix || ""}${prefix} attached`);
        });
        this.app.use(this.router.routes());
        this.app.use((ctx: any) => {
            const request = new RequestModel(ctx);
            logger.debug(`-> ${ctx.request.method} ${ctx.request.url} request is not supported - ${request.remoteIP || "unknown"}`);
            const message = `[请求有误]: 正确请求应为POST -> /v1/chat/completions，当期请求为 ${ctx.request.method} -> ${ctx.request.url} 请纠正`;
            logger.warn(message);
            const failureBody = new FailureBody(new Error(message));
            const response = new Response(failureBody);
            response.injectTo(ctx);
            if(config.system.requestLog)
                logger.info(`<- ${request.method} ${request.url} ${response.time - request.time}ms`);
        });
    }

    #normalizeRoutes(routes: any[]): RouteItem[] {
        const prefix = config.service.urlPrefix || "";
        const normalized: RouteItem[] = [];
        routes.forEach((route: any) => {
            const routePrefix = route.prefix || "";
            for (let method in route) {
                if(method === "prefix") continue;
                if (!_.isObject(route[method])) {
                    logger.warn(`Router ${routePrefix} ${method} invalid`);
                    continue;
                }
                for (let uri in route[method]) {
                    const path = this.#normalizePath(prefix, routePrefix, uri);
                    normalized.push({
                        method: method.toUpperCase(),
                        path,
                        handler: route[method][uri]
                    });
                }
            }
        });
        return normalized;
    }

    #normalizePath(...parts: string[]): string {
        const joined = "/" + util.urlJoin(...parts.filter(Boolean));
        return joined === "//" ? "/" : joined.replace(/\/{2,}/g, "/");
    }

    async #buildFetchContext(req: globalThis.Request) {
        const url = new URL(req.url);
        const headers = Object.fromEntries(req.headers);
        const type = headers["content-type"] || headers["Content-Type"] || "";
        const { body, files } = await this.#parseFetchBody(req, type);
        return {
            request: {
                method: req.method,
                url: url.pathname + url.search,
                path: url.pathname,
                type,
                headers,
                search: url.search,
                body,
                files
            },
            query: Object.fromEntries(url.searchParams.entries()),
            params: {},
            ip: headers["x-real-ip"] || headers["x-forwarded-for"] || null,
            set: (_headers: any) => {},
            redirect: (_url: string) => {},
            get status() { return undefined; },
            set status(_value) {},
            get type() { return undefined; },
            set type(_value) {},
            body: null
        };
    }

    async #parseFetchBody(req: globalThis.Request, type: string) {
        if (["GET", "HEAD"].includes(req.method)) return { body: {}, files: {} };
        try {
            if (type.includes("application/json")) {
                const body = await req.json();
                return { body, files: {} };
            }
            if (type.includes("application/x-www-form-urlencoded")) {
                const form = new URLSearchParams(await req.text());
                return { body: Object.fromEntries(form.entries()), files: {} };
            }
            if (type.includes("multipart/form-data")) {
                const form = await req.formData();
                const body: any = {};
                const files: any = {};
                for (const [key, value] of form.entries()) {
                    if (value instanceof File) {
                        files[key] = value;
                    } else {
                        body[key] = value;
                    }
                }
                return { body, files };
            }
            const text = await req.text();
            return { body: text, files: {} };
        } catch (err) {
            logger.warn("Parse request body failed:", err);
            return { body: {}, files: {} };
        }
    }

    #matchRoute(method: string, path: string): RouteItem | null {
        const normalizedPath = path.replace(/\/+$/, "") || "/";
        return this.fetchRoutes.find(route => {
            const routePath = route.path.replace(/\/+$/, "") || "/";
            return route.method === method && routePath === normalizedPath;
        }) || null;
    }

    /**
     * 请求处理
     * 
     * @param ctx 上下文
     * @param routeFn 路由方法
     */
    #requestProcessing(ctx: any, routeFn: Function): Promise<any> {
        return new Promise(resolve => {
            const request = new RequestModel(ctx);
            try {
                if(config.system.requestLog)
                    logger.info(`-> ${request.method} ${request.url}`);
                    routeFn(request)
                .then(response => {
                    try {
                        if(!Response.isInstance(response)) {
                            const _response = new Response(response);
                            ctx && _response.injectTo(ctx);
                            return resolve({ request, response: _response });
                        }
                        ctx && response.injectTo(ctx);
                        resolve({ request, response });
                    }
                    catch(err) {
                        logger.error(err);
                        const failureBody = new FailureBody(err);
                        const response = new Response(failureBody);
                        ctx && response.injectTo(ctx);
                        resolve({ request, response });
                    }
                })
                .catch(err => {
                    try {
                        logger.error(err);
                        const failureBody = new FailureBody(err);
                        const response = new Response(failureBody);
                        ctx && response.injectTo(ctx);
                        resolve({ request, response });
                    }
                    catch(err) {
                        logger.error(err);
                        const failureBody = new FailureBody(err);
                        const response = new Response(failureBody);
                        ctx && response.injectTo(ctx);
                        resolve({ request, response });
                    }
                });
            }
            catch(err) {
                logger.error(err);
                const failureBody = new FailureBody(err);
                const response = new Response(failureBody);
                ctx && response.injectTo(ctx);
                resolve({ request, response });
            }
        });
    }

    /**
     * 监听端口
     */
    async listen() {
        if (this.isFetchServer && typeof (Deno as any).serve === "function") {
            (Deno as any).serve(async (req: Request) => {
                const ctx = await this.#buildFetchContext(req);
                const matched = this.#matchRoute(req.method, ctx.request.path);
                if (!matched) {
                    const message = `[请求有误]: 正确请求应为POST -> /v1/chat/completions，当期请求为 ${req.method} -> ${ctx.request.path} 请纠正`;
                    logger.warn(message);
                    return new Response(new FailureBody(new Exception(EX.SYSTEM_NOT_ROUTE_MATCHING, message)), { statusCode: 404 }).toWebResponse();
                }
                const { request, response } = await this.#requestProcessing(ctx, matched.handler);
                if(response != null && config.system.requestLog)
                    logger.info(`<- ${request.method} ${request.url} ${response.time - request.time}ms`);
                return Response.isInstance(response) ? response.toWebResponse() : new Response(response).toWebResponse();
            });
            logger.success(`Server listening via Deno.serve (prefix: ${config.service.urlPrefix || "/"})`);
            return;
        }
        await this.#ensureNodeApp();
        const host = config.service.host;
        const port = config.service.port;
        await Promise.all([
            new Promise((resolve, reject) => {
                if(host === "0.0.0.0" || host === "localhost" || host === "127.0.0.1")
                    return resolve(null);
                this.app.listen(port, "localhost", err => {
                    if(err) return reject(err);
                    resolve(null);
                });
            }),
            new Promise((resolve, reject) => {
                this.app.listen(port, host, err => {
                    if(err) return reject(err);
                    resolve(null);
                });
            })
        ]);
        logger.success(`Server listening on port ${port} (${host})`);
    }

}

export default new Server();
