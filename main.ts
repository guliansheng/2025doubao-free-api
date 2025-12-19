import { serve } from "https://deno.land/std@0.208.0/http/server.ts";

import routes from "./src/api/routes/index.ts";
import RequestWrapper from "./src/lib/request/Request.ts";
import ResponseWrapper from "./src/lib/response/Response.ts";
import FailureBody from "./src/lib/response/FailureBody.ts";
import logger from "./src/lib/logger.ts";
import config from "./src/lib/config.ts";

type RouteEntry = {
  method: string;
  path: string;
  handler: (req: RequestWrapper) => Promise<any>;
};

const basePrefix = config.service.urlPrefix || "";
const routeTable: RouteEntry[] = [];

for (const route of routes) {
  const prefix = route.prefix || "";
  for (const method of Object.keys(route)) {
    if (method === "prefix") continue;
    for (const uri of Object.keys(route[method])) {
      const fullPath = `${basePrefix}${prefix}${uri || ""}` || "/";
      routeTable.push({
        method: method.toUpperCase(),
        path: fullPath,
        handler: route[method][uri],
      });
    }
  }
}

const corsHeaders = new Headers({
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
});

async function parseBody(req: Request) {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return await req.json();
    } catch {
      return {};
    }
  }
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(await req.text());
    return Object.fromEntries(form.entries());
  }
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    return Object.fromEntries(form.entries());
  }
  if (contentType.startsWith("text/")) return await req.text();
  return await req.text().catch(() => null);
}

function buildCtx(req: Request, body: any) {
  const url = new URL(req.url);
  const headers = Object.fromEntries(req.headers.entries());
  return {
    request: {
      method: req.method,
      url: req.url,
      path: url.pathname,
      type: headers["content-type"],
      headers,
      search: url.search,
      body: body || {},
      files: {},
    },
    query: Object.fromEntries(url.searchParams.entries()),
    params: {},
    ip:
      headers["x-real-ip"] ||
      headers["x-forwarded-for"] ||
      headers["cf-connecting-ip"] ||
      null,
  };
}

function withCors(res: Response) {
  const headers = new Headers(res.headers);
  corsHeaders.forEach((v, k) => {
    if (!headers.has(k)) headers.set(k, v);
  });
  return new Response(res.body, { status: res.status, headers });
}

async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

  const url = new URL(req.url);
  const route = routeTable.find(
    (item) => item.method === req.method && item.path === url.pathname,
  );
  if (!route)
    return withCors(new Response("Not Found", { status: 404 }));

  try {
    const parsedBody = await parseBody(req);
    const requestWrapper = new RequestWrapper(buildCtx(req, parsedBody));
    const result = await route.handler(requestWrapper);
    const wrapped = ResponseWrapper.isInstance(result)
      ? (result as ResponseWrapper)
      : new ResponseWrapper(result);
    return withCors(wrapped.toWebResponse());
  } catch (err) {
    logger.error(err);
    const failure = new ResponseWrapper(new FailureBody(err));
    return withCors(failure.toWebResponse());
  }
}

logger.info("Starting Deno server for doubao-free-api...");
serve(handler);
