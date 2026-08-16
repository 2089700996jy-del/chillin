// 把根目录的 Web 资源同步到 www/（Capacitor 的 webDir）
// 改完 index.html / app.js / style.css 后运行：npm run sync:web
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const www = path.join(root, 'www');
const files = ['index.html', 'app.js', 'style.css', 'manifest.json', 'sw.js'];
const dirs = ['icons'];

fs.mkdirSync(www, { recursive: true });
for (const f of files) {
    fs.copyFileSync(path.join(root, f), path.join(www, f));
}
for (const d of dirs) {
    fs.cpSync(path.join(root, d), path.join(www, d), { recursive: true });
}
console.log('✅ 已同步 Web 资源到 www/');
