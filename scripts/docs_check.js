// So danh sách route đăng ký thật trong src/routes/ với docs/api.md (cả hai chiều).
// Chỉ đọc file, không cần database hay .env.   npm run docs:check
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// Route trong code: mount trong routes/index.js + router.<method>('...') trong từng file.
function codeRoutes() {
  const index = read('src/routes/index.js');
  const routes = [];
  for (const m of index.matchAll(/router\.(get|post|patch|put|delete)\('([^']+)'/g)) {
    routes.push(`${m[1].toUpperCase()} /api${m[2]}`);
  }
  for (const m of index.matchAll(/router\.use\('([^']+)',\s*require\('\.\/([^']+)'\)\)/g)) {
    const src = read(`src/routes/${m[2]}.js`);
    for (const r of src.matchAll(/router\.(get|post|patch|put|delete)\('([^']+)'/g)) {
      routes.push(`${r[1].toUpperCase()} /api${m[1]}${r[2] === '/' ? '' : r[2]}`);
    }
  }
  return routes;
}

// Route trong tài liệu: bảng tra (mục 20) và tiêu đề mô tả từng endpoint.
function docRoutes() {
  const doc = read('docs/api.md');
  const table = [...doc.matchAll(/^\| (GET|POST|PATCH|PUT|DELETE) \| `(\/api[^`]*)` \|/gm)].map((m) => `${m[1]} ${m[2]}`);
  const headings = [...doc.matchAll(/^#{3,4} `(GET|POST|PATCH|PUT|DELETE) (\/api[^`]*)`/gm)].map((m) => `${m[1]} ${m[2]}`);
  return { table, headings };
}

const code = codeRoutes();
const { table, headings } = docRoutes();
const dup = (list) => list.filter((x, i) => list.indexOf(x) !== i);
const problems = [];
const report = (label, list) => { if (list.length) problems.push(`${label}:\n  ${list.join('\n  ')}`); };

report('Route trong code nhưng thiếu ở bảng tra docs/api.md', code.filter((r) => !table.includes(r)));
report('Route trong bảng tra nhưng không có trong code', table.filter((r) => !code.includes(r)));
report('Route trong code nhưng chưa có mục mô tả (### `METHOD /api/...`)', code.filter((r) => !headings.includes(r)));
report('Mục mô tả cho route không có trong code', headings.filter((r) => !code.includes(r)));
report('Route đăng ký trùng trong code', dup(code));
report('Dòng trùng trong bảng tra', dup(table));

console.log(`Route trong code: ${code.length}, bảng tra: ${table.length}, mục mô tả: ${headings.length}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Khớp 100%: mọi route có trong bảng tra và có mục mô tả, không thừa, không trùng.');
}
