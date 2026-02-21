const fs = require('fs');
const html = fs.readFileSync('S:/Antigravity/JetServer installation/TempusGeo-Deploy/CLIENT_USER/index.html', 'utf8');
const regex = /action:\s*['"]([a-zA-Z]+)['"]/g;
const acts = [];
let m;
while ((m = regex.exec(html)) !== null) { acts.push(m[1]); }
const uniq = [...new Set(acts)].sort();
console.log('=== CLIENT_USER Actions ===');
uniq.forEach(a => console.log(' -', a));
console.log('\nTotal unique actions:', uniq.length);
