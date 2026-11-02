#!/usr/bin/env node
/**
 * 发布与测试前的 Node 版本闸门。
 * 低于 22.5 时 node:sqlite 不可用，集成用例会被跳过；这里直接失败，避免“跳过也算通过”。
 */
const MIN_MAJOR = 22;
const MIN_MINOR = 5;
const [major, minor] = process.versions.node.split('.').map(Number);

if (major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR)) {
    console.error('✖ 需要 Node ≥ ' + MIN_MAJOR + '.' + MIN_MINOR + '，当前 ' + process.version);
    console.error('  请升级 Node 后再运行 npm test / npm run ship。');
    process.exit(1);
}
