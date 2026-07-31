import { launch, open } from '../src/driver/browser.js';
const { browser, page } = await launch({ headless: true });
await open(page, 'https://play.quip.gg/');
await page.waitForTimeout(4000);
const dump = await page.evaluate(() => {
  const modal = document.querySelector('[class*="modal"],[role="dialog"],[class*="onboard"],[class*="overlay"]');
  const btns = [...document.querySelectorAll('button')].map(b => ({
    t: (b.textContent||'').trim().slice(0,44),
    c: b.className,
    vis: !!(b.offsetParent),
    dis: b.disabled,
  }));
  return { modalClass: modal ? modal.className : null,
           modalHtml: modal ? modal.outerHTML.slice(0,700) : null, btns };
});
console.log('MODAL CLASS:', dump.modalClass);
console.log('MODAL HTML:', dump.modalHtml);
console.log('--- buttons ---');
for (const b of dump.btns) console.log(`vis=${b.vis?1:0} dis=${b.dis?1:0} "${b.t}" .${b.c}`);
await browser.close();
