import { chromium } from 'playwright';
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://www.google.com/maps/search/custom+closets+Atlanta,+Georgia');
  await page.waitForTimeout(5000);
  
  const hrefs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href]')).map(a => a.href);
  });
  
  console.log('Found ' + hrefs.length + ' links');
  console.log('Sample links:');
  hrefs.filter(h => h.includes('maps')).slice(0, 10).forEach(h => console.log(h));
  
  await browser.close();
})();
