const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const p = await b.newPage({ viewport: { width: 640, height: 640 } });
  await p.setContent('<html><body style="margin:0">' + fs.readFileSync('logo.svg', 'utf8') + '</body></html>');
  await p.screenshot({ path: 'logo.png' });
  // предпросмотр круглой аватарки
  await p.setContent('<html><body style="margin:0;background:#17212b;display:flex;gap:30px;align-items:center;justify-content:center;height:640px;width:640px">' +
    '<div style="width:320px;height:320px;border-radius:50%;overflow:hidden">' + fs.readFileSync('logo.svg','utf8').replace('width="640" height="640"','width="320" height="320"') + '</div>' +
    '<div style="width:80px;height:80px;border-radius:50%;overflow:hidden">' + fs.readFileSync('logo.svg','utf8').replace('width="640" height="640"','width="80" height="80"').replace(/id="(\w+)"/g,'id="s$1"').replace(/url\(#(\w+)\)/g,'url(#s$1)') + '</div></body></html>');
  await p.screenshot({ path: 'preview.png' });
  await b.close();
})();
