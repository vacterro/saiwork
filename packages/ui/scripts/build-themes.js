const fs = require('fs');
const path = require('path');

const wintageThemesDir = 'v:\\___VAC\\__K\\__CODE\\_TAMPERMONKEY\\_WIN95THEME\\Wintage\\themes';
const outputCssFile = path.join(__dirname, '..', 'src', 'styles', 'wintage-themes.css');
const outputTsFile = path.join(__dirname, '..', 'src', 'lib', 'wintage-themes.ts');

let cssContent = `/* Auto-generated from Wintage themes */\n\n`;
let tsContent = `export interface WintageTheme {\n  slug: string;\n  label: string;\n}\n\nexport const wintageThemes: WintageTheme[] = [\n`;

const files = fs.readdirSync(wintageThemesDir).filter(f => f.endsWith('.json'));

let themes = [];

for (const file of files) {
  const filePath = path.join(wintageThemesDir, file);
  const themeData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  
  const slug = themeData.slug;
  const label = themeData.label;
  const tokens = themeData.tokens;
  
  themes.push({ slug, label });
  
  let selectors = `:root[data-theme="${slug}"]`;
  if (slug === 'goldendefault') {
    selectors = `:root, :root:not([data-theme]), :root[data-theme="system"], :root[data-theme="${slug}"]`;
  }
  
  cssContent += `${selectors} {\n`;
  for (const [key, value] of Object.entries(tokens)) {
    cssContent += `  --${key}: ${value};\n`;
  }
  cssContent += `}\n\n`;
}

fs.writeFileSync(outputCssFile, cssContent);

for (const t of themes) {
  tsContent += `  { slug: "${t.slug}", label: "${t.label}" },\n`;
}
tsContent += `];\n`;
fs.writeFileSync(outputTsFile, tsContent);

console.log(`Generated Wintage themes (${themes.length} themes).`);
