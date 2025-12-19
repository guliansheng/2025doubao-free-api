import mime from 'mime';
import _ from 'lodash';
import { Readable } from "node:stream";

import Body from './Body.ts';
import util from '../util.ts';

export interface ResponseOptions {
    statusCode?: number;
    type?: string;
    headers?: Record<string, any>;
    redirect?: string;
    body?: any;
    size?: number;
    time?: number;
}

export default class Response {

    /** 响应HTTP状态码 */
    statusCode: number;
    /** 响应内容类型 */
    type: string;
    /** 响应headers */
    headers: Record<string, any>;
    /** 重定向目标 */
    redirect: string;
    /** 响应载荷 */
    body: any;
    /** 响应载荷大小 */
    size: number;
    /** 响应时间戳 */
    time: number;

    constructor(body: any, options: ResponseOptions = {}) {
        const { statusCode, type, headers, redirect, size, time } = options;
        this.statusCode = Number(_.defaultTo(statusCode, Body.isInstance(body) ? body.statusCode : undefined))
        this.type = type;
        this.headers = headers;
        this.redirect = redirect;
        this.size = size;
        this.time = Number(_.defaultTo(time, util.timestamp()));
        this.body = body;
    }

    injectTo(ctx) {
        this.redirect && ctx.redirect(this.redirect);
        this.statusCode && (ctx.status = this.statusCode);
        this.type && (ctx.type = mime.getType(this.type) || this.type);
        const headers = this.headers || {};
        if(this.size && !headers["Content-Length"] && !headers["content-length"])
            headers["Content-Length"] = this.size;
        ctx.set(headers);
        if(Body.isInstance(this.body))
            ctx.body = this.body.toObject();
        else
            ctx.body = this.body;
    }

    /**
     * Convert to a fetch Response so we can run on Deno Deploy or any web runtime.
     */
    toWebResponse() {
        const headers = new Headers(this.headers || {});
        const status = this.statusCode || 200;
        if (this.type && !headers.has("content-type"))
            headers.set("content-type", mime.getType(this.type) || this.type);

        let body: any = this.body;
        if (Body.isInstance(body)) {
            body = JSON.stringify(body.toObject());
            headers.set("content-type", headers.get("content-type") || "application/json");
        }
        else if (_.isPlainObject(body) || Array.isArray(body)) {
            body = JSON.stringify(body);
            headers.set("content-type", headers.get("content-type") || "application/json");
        }
        else if (body instanceof Readable) {
            // Node stream -> Web stream
            if ((Readable as any).toWeb)
                body = (Readable as any).toWeb(body);
            else {
                const iterator = (body as any)[Symbol.asyncIterator]
                    ? (body as any)[Symbol.asyncIterator]()
                    : null;
                body = iterator
                    ? new ReadableStream({
                        async pull(controller) {
                            const { value, done } = await iterator.next();
                            if (done) return controller.close();
                            controller.enqueue(value);
                        },
                        cancel() {
                            (body as any)?.destroy?.();
                        }
                    })
                    : body as any;
            }
        }

        return new globalThis.Response(body as BodyInit | null, { status, headers });
    }

    static isInstance(value) {
        return value instanceof Response;
    }

}
