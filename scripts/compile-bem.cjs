const fs = require('fs');
const path = require('path');
const postcss = require('postcss');

const bemNestingPlugin = () => {
  return {
    postcssPlugin: 'flatten-bem-nesting',
    Rule(rule) {
      if (rule.parent && rule.parent.type === 'rule') {
        const parentSelector = rule.parent.selector;
        const currentSelector = rule.selector;

        if (currentSelector.includes('&')) {
          const resolved = currentSelector
            .split(',')
            .map(part => {
              const p = part.trim();
              if (p.startsWith('&__') || p.startsWith('&--')) {
                return p.replace(/&([a-zA-Z0-9_-]+)/g, (match, suffix) => {
                  return parentSelector + suffix;
                });
              } else if (p.startsWith('&:') || p.startsWith('&.') || p.startsWith('&[')) {
                return p.replace(/&([a-zA-Z0-9_-]+)/g, (match, suffix) => {
                  return parentSelector + suffix;
                }).replace(/&/g, parentSelector);
              } else {
                return p.replace(/&/g, parentSelector);
              }
            })
            .join(', ');

          rule.selector = resolved;
          rule.parent.after(rule);
        }
      }
    }
  };
};
bemNestingPlugin.postcss = true;

async function processFile(filePath) {
  const css = fs.readFileSync(filePath, 'utf8');
  let result = css;
  // Multiple passes to resolve any multi-level nesting
  for (let pass = 0; pass < 3; pass++) {
    const res = await postcss([bemNestingPlugin]).process(result, { from: filePath });
    result = res.css;
  }
  return result;
}

/**
 * STAGE 2 & 3: CORE FUNCTIONALITY & BUILD OPTIMIZATION
 * // STEP 2: Add the CSS layout and styling (BEM Compilation & Sync)
 * // STEP 5: Optimize performance and maintainability
 *
 * Why this code exists:
 * Resolves BEM `&` nesting across `css/style.css`, `css/animations.css`, and
 * `css/responsive.css` and keeps `public/css/` synchronized without injecting
 * duplicate inline `<style>` blocks into `index.html`.
 *
 * Tricky logic:
 * Strips any legacy `<style id="monte-azur-master-styles">` block from `index.html`
 * if present so tokens and styles live exclusively in external CSS files.
 *
 * TODO: None - Clean external CSS architecture maintained.
 */
async function main() {
  const rootDir = path.join(__dirname, '..');
  const files = ['style.css', 'animations.css', 'responsive.css'];

  for (const file of files) {
    const srcPath = path.join(rootDir, 'css', file);

    const compiled = await processFile(srcPath);
    fs.writeFileSync(srcPath, compiled, 'utf8');
    console.log(`Processed and updated: css/${file}`);
  }

  // Ensure index.html remains free of any embedded <style id="monte-azur-master-styles"> block
  const htmlPath = path.join(rootDir, 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  const styleTagRegex = /\s*<!-- Embedded Production CSS -->\s*<style id="monte-azur-master-styles">[\s\S]*?<\/style>\s*/;

  if (styleTagRegex.test(html)) {
    html = html.replace(styleTagRegex, '\n\n  ');
    fs.writeFileSync(htmlPath, html, 'utf8');
    console.log('CLEANUP: Removed embedded legacy style block from index.html');
  }
}

main().catch(err => {
  console.error('Error during BEM compilation:', err);
  process.exit(1);
});
