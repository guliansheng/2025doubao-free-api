import path from 'node:path';
import _util from 'node:util';

import 'colors';
import _ from 'lodash';
import fs from 'fs-extra';
import { format as dateFormat } from 'date-fns';
import process from "node:process";

import config from './config.ts';
import util from './util.ts';


// 全局日志文本清洗：移�?掩码可能出现�?base64 �?data URI，防止日志泄�?爆炸
function sanitizeLogString(input: string): string {
  try {
    if (!input || typeof input !== "string") return input as any;
    let s = input;

    // 处理 data:*;base64, 段落（逐字符向后扫描，直到遇到�?base64 字符�?
    const prefix = "data:";
    let idx = s.indexOf(prefix);
    while (idx !== -1) {
      const semi = s.indexOf(";base64,", idx);
      if (semi === -1) break;
      let end = semi + ";base64,".length;
      const start = idx;
      let count = 0;
      while (end < s.length && /[A-Za-z0-9+/=]/.test(s[end])) { end++; count++; }
      const replacement = `data:...;base64,[OMITTED,len=${count}]`;
      s = s.slice(0, start) + replacement + s.slice(end);
      idx = s.indexOf(prefix, start + replacement.length);
    }

    // 替换过长�?base64-like 连续�?
    s = s.replace(/([A-Za-z0-9+/=]{256,})/g, (m) => `[[OMITTED_BASE64 len=${m.length}]]`);

    // 防止超长日志刷屏：硬性截�?
    if (s.length > 8000) {
      s = s.slice(0, 8000) + `...[[TRUNCATED len=${s.length}]]`;
    }

    return s;
  } catch {
    return input as any;
  }
}

const isVercelEnv = process.env.VERCEL;
const isDenoEnv = typeof Deno !== "undefined";
const isFileLoggingEnabled = !isVercelEnv && !isDenoEnv;

class LogWriter {

    #buffers = [];

    constructor() {
        if (isFileLoggingEnabled) {
            fs.ensureDirSync(config.system.logDirPath);
            this.work();
        }
    }

    push(content) {
        const buffer = Buffer.from(content);
        this.#buffers.push(buffer);
    }

    writeSync(buffer) {
        isFileLoggingEnabled && fs.appendFileSync(path.join(config.system.logDirPath, `/${util.getDateString()}.log`), buffer);
    }

    async write(buffer) {
        if (isFileLoggingEnabled)
            await fs.appendFile(path.join(config.system.logDirPath, `/${util.getDateString()}.log`), buffer);
    }

    flush() {
        if(!this.#buffers.length) return;
        isFileLoggingEnabled && fs.appendFileSync(path.join(config.system.logDirPath, `/${util.getDateString()}.log`), Buffer.concat(this.#buffers));
    }

    work() {
        if (!this.#buffers.length) return setTimeout(this.work.bind(this), config.system.logWriteInterval);
        const buffer = Buffer.concat(this.#buffers);
        this.#buffers = [];
        this.write(buffer)
        .finally(() => setTimeout(this.work.bind(this), config.system.logWriteInterval))
        .catch(err => console.error("Log write error:", err));
    }

}

class LogText {

    /** @type {string} 日志级别 */
    level;
    /** @type {string} 日志文本 */
    text;
    /** @type {string} 日志来源 */
    source;
    /** @type {Date} 日志发生时间 */
    time = new Date();

    constructor(level, ...params) {
        this.level = level;
        const raw = _util.format.apply(null, params);
        this.text = sanitizeLogString(raw);
        this.source = this.#getStackTopCodeInfo();
    }

    #getStackTopCodeInfo() {
        const unknownInfo = { name: "unknown", codeLine: 0, codeColumn: 0 };
        const stackArray = new Error().stack.split("\n");
        const text = stackArray[4];
        if (!text)
            return unknownInfo;
        const match = text.match(/at (.+) \((.+)\)/) || text.match(/at (.+)/);
        if (!match || !_.isString(match[2] || match[1]))
            return unknownInfo;
        const temp = match[2] || match[1];
        const _match = temp.match(/([a-zA-Z0-9_\-\.]+)\:(\d+)\:(\d+)$/);
        if (!_match)
            return unknownInfo;
        const [, scriptPath, codeLine, codeColumn] = _match as any;
        return {
            name: scriptPath ? scriptPath.replace(/.js$/, "") : "unknown",
            path: scriptPath || null,
            codeLine: parseInt(codeLine || 0),
            codeColumn: parseInt(codeColumn || 0)
        };
    }

    toString() {
        return `[${dateFormat(this.time, "yyyy-MM-dd HH:mm:ss.SSS")}][${this.level}][${this.source.name}<${this.source.codeLine},${this.source.codeColumn}>] ${this.text}`;
    }

}

class Logger {

    /** @type {Object} 系统配置 */
    config = {};
    /** @type {Object} 日志级别映射 */
    static Level = {
        Success: "success",
        Info: "info",
        Log: "log",
        Debug: "debug",
        Warning: "warning",
        Error: "error",
        Fatal: "fatal"
    };
    /** @type {Object} 日志级别文本颜色樱色 */
    static LevelColor = {
        [Logger.Level.Success]: "green",
        [Logger.Level.Info]: "brightCyan",
        [Logger.Level.Debug]: "white",
        [Logger.Level.Warning]: "brightYellow",
        [Logger.Level.Error]: "brightRed",
        [Logger.Level.Fatal]: "red"
    };
    #writer;

    constructor() {
        this.#writer = new LogWriter();
    }

    header() {
        this.#writer.writeSync(Buffer.from(`\n\n===================== LOG START ${dateFormat(new Date(), "yyyy-MM-dd HH:mm:ss.SSS")} =====================\n\n`));
    }

    footer() {
        this.#writer.flush();  //将未写入文件的日志缓存写�?
        this.#writer.writeSync(Buffer.from(`\n\n===================== LOG END ${dateFormat(new Date(), "yyyy-MM-dd HH:mm:ss.SSS")} =====================\n\n`));
    }

    success(...params) {
        const content = new LogText(Logger.Level.Success, ...params).toString();
        console.info(content[Logger.LevelColor[Logger.Level.Success]]);
        this.#writer.push(content + "\n");
    }

    info(...params) {
        const content = new LogText(Logger.Level.Info, ...params).toString();
        console.info(content[Logger.LevelColor[Logger.Level.Info]]);
        this.#writer.push(content + "\n");
    }

    log(...params) {
        const content = new LogText(Logger.Level.Log, ...params).toString();
        console.log(content[Logger.LevelColor[Logger.Level.Log]]);
        this.#writer.push(content + "\n");
    }

    debug(...params) {
        if(!config.system.debug) return;  //非调试模式忽略debug
        const content = new LogText(Logger.Level.Debug, ...params).toString();
        console.debug(content[Logger.LevelColor[Logger.Level.Debug]]);
        this.#writer.push(content + "\n");
    }

    warn(...params) {
        const content = new LogText(Logger.Level.Warning, ...params).toString();
        console.warn(content[Logger.LevelColor[Logger.Level.Warning]]);
        this.#writer.push(content + "\n");
    }

    error(...params) {
        const content = new LogText(Logger.Level.Error, ...params).toString();
        console.error(content[Logger.LevelColor[Logger.Level.Error]]);
        this.#writer.push(content);
    }

    fatal(...params) {
        const content = new LogText(Logger.Level.Fatal, ...params).toString();
        console.error(content[Logger.LevelColor[Logger.Level.Fatal]]);
        this.#writer.push(content);
    }

    destory() {
        this.#writer.destory();
    }

}

export default new Logger();

