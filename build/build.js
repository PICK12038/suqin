/**
 * build.js — 把 src/ 下的分离文件打包成一个可以直接双击打开、也可以用微信转发的 HTML。
 *
 *   node build/build.js
 *
 * 产出：dist/速勤-考勤工作台.html
 * 特性：零外部请求（CSS、三个 JS 全部内联），离线可用，file:// 打开即可。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const DIST = path.join(__dirname, '..', 'dist');
const OUT_NAME = '速勤-考勤工作台.html';

function read(name) {
  return fs.readFileSync(path.join(SRC, name), 'utf8');
}

/** CSS：去掉注释、压缩空白（不动字符串里的内容，CSS 里的 content 很少） */
function minifyCSS(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s*([{};:,>])\s*/g, '$1')
    .replace(/;}/g, '}')
    .replace(/\s+/g, ' ')
    .trim();
}

/** JS：只删整行的 // 注释和行首缩进，避免正则误伤字符串/正则字面量 */
function minifyJS(js) {
  return js
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .map((line) => line.replace(/^\s+/, ''))
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function guard(code, tag) {
  // 防止内联脚本/样式里出现 </script> </style> 提前结束标签
  return code.replace(new RegExp('</' + tag, 'gi'), function () { return '<\\/' + tag; });
}

function main() {
  const t0 = Date.now();
  let html = read('index.html');

  const css = minifyCSS(read('styles.css'));
  // 替换值必须用函数返回：源码里的 $$ / $& / $1 会被 String.replace 当成插值
  html = html.replace(
    /<link[^>]+href="styles\.css"[^>]*>/i,
    function () { return '<style>\n' + guard(css, 'style') + '\n</style>'; }
  );

  ['pinyin.js', 'core.js', 'app.js'].forEach((file) => {
    const js = minifyJS(read(file));
    const re = new RegExp('<script[^>]+src="' + file.replace('.', '\\.') + '"[^>]*>\\s*</script>', 'i');
    if (!re.test(html)) throw new Error('找不到脚本引用：' + file);
    html = html.replace(re, function () {
      return '<script>\n/* ' + file + ' */\n' + guard(js, 'script') + '\n</script>';
    });
  });

  const version = (read('core.js').match(/version:\s*'([^']+)'/) || [])[1] || '0.0.0';
  const stamp = new Date().toISOString().slice(0, 10);
  html = html.replace(/<\/head>/i, function () {
    return '<!-- 速勤 SuQin v' + version + ' · 打包于 ' + stamp + ' · 单文件离线版 -->\n</head>';
  });

  if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });
  const out = path.join(DIST, OUT_NAME);
  fs.writeFileSync(out, html, 'utf8');

  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  const left = html.match(/(?:src|href)="(?!data:|#)([^"]+)"/g);
  console.log('已生成 ' + out);
  console.log('大小 ' + kb + ' KB · 耗时 ' + (Date.now() - t0) + ' ms');
  console.log('外部引用：' + (left ? left.join(', ') : '无（完全自包含）'));
}

main();
