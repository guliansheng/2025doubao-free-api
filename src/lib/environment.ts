import path from 'node:path';
import process from 'node:process';

import fs from 'fs-extra';
import minimist from 'minimist';
import _ from 'lodash';

const isDenoEnv = typeof Deno !== "undefined";
const cmdArgs = minimist((process?.argv || []).slice(2));  //获取命令行参数
const envVars = process?.env || (isDenoEnv && (Deno as any).env ? (Deno as any).env.toObject() : {});  //获取环境变量

class Environment {

    /** 命令行参数*/
    cmdArgs: any;
    /** 环境变量 */
    envVars: any;
    /** 环境名称 */
    env?: string;
    /** 服务名称 */
    name?: string;
    /** 服务地址 */
    host?: string;
    /** 服务端口 */
    port?: number;
    /** 包参数*/
    package: any;

    constructor(options: any = {}) {
        const { cmdArgs, envVars, package: _package } = options;
        this.cmdArgs = cmdArgs;
        this.envVars = envVars;
        this.env = _.defaultTo(cmdArgs.env || envVars.SERVER_ENV, 'dev');
        this.name = cmdArgs.name || envVars.SERVER_NAME || undefined;
        this.host = cmdArgs.host || envVars.SERVER_HOST || undefined;
        this.port = Number(cmdArgs.port || envVars.SERVER_PORT) ? Number(cmdArgs.port || envVars.SERVER_PORT) : undefined;
        this.package = _package;
    }

}

function loadPackageJson() {
    try {
        return JSON.parse(fs.readFileSync(path.join(path.resolve(), "package.json")).toString());
    } catch (_) {
        const fallbackVersion = envVars?.npm_package_version || envVars?.VERCEL_GIT_COMMIT_SHA || "0.0.0";
        return { version: fallbackVersion };
    }
}

export default new Environment({
    cmdArgs,
    envVars,
    package: loadPackageJson()
});
