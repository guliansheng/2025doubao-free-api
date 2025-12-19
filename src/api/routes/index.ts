import fs from 'fs-extra';

import Response from '@/lib/response/Response.ts';
import chat from "./chat.ts";
import ping from "./ping.ts";
import token from './token.ts';
import models from './models.ts';

let cachedWelcome: string | Uint8Array | null = null;

async function loadWelcomeHtml() {
    if (cachedWelcome) return cachedWelcome;
    // 优先尝试读取随包带的静态文件，失败后使用内置文案
    try {
        const fileUrl = new URL("../../../public/welcome.html", import.meta.url);
        cachedWelcome = await (typeof Deno !== "undefined" ? Deno.readFile(fileUrl) : fs.readFile(fileUrl));
    } catch {
        try {
            cachedWelcome = await fs.readFile('public/welcome.html');
        } catch {
            cachedWelcome = "<h1>Doubao Free API</h1><p>Service is running.</p>";
        }
    }
    return cachedWelcome;
}

export default [
    {
        get: {
            '/': async () => {
                const content = await loadWelcomeHtml();
                return new Response(content, {
                    type: 'html',
                    headers: {
                        Expires: '-1'
                    }
                });
            }
        }
    },
    chat,
    ping,
    token,
    models
];
