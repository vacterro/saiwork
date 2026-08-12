const fs = require('fs');
const path = require('path');

const wintageThemesDir = 'v:\\___VAC\\__K\\__CODE\\_TAMPERMONKEY\\_WIN95THEME\\Wintage\\themes';
const outputCssFile = path.join(__dirname, '..', 'src', 'styles', 'wintage-themes.css');
const outputTsFile = path.join(__dirname, '..', 'src', 'lib', 'wintage-themes.ts');
const requiredTokenKeys = [
  'background', 'backgroundSoft', 'surface', 'surfaceRaised', 'surfaceAlt',
  'borderDark', 'borderHighlight', 'bevelLight', 'borderMuted',
  'textPrimary', 'textSecondary', 'textMuted', 'accentTeal', 'accentTealDeep',
  'success', 'warning', 'danger', 'dangerText', 'selection', 'compareBack', 'link',
];

let cssContent = `/* Auto-generated from Wintage themes */\n\n`;
let tsContent = `export interface WintageTheme {\n  slug: string\n  label: string\n  isDark: boolean\n}\n\nexport const wintageThemes: WintageTheme[] = [\n`;

const files = fs.readdirSync(wintageThemesDir).filter(f => f.endsWith('.json'));

let themes = [];
const seenSlugs = new Set();
const seenLabels = new Set();

for (const file of files) {
  const filePath = path.join(wintageThemesDir, file);
  const themeData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  
  const slug = themeData.slug;
  const label = themeData.label;
  const tokens = themeData.tokens;
  if (!/^[a-z][a-z0-9]*$/.test(slug) || typeof label !== 'string') throw new Error(`Invalid theme identity in ${file}`);
  if (seenSlugs.has(slug) || seenLabels.has(label)) throw new Error(`Duplicate theme identity in ${file}`);
  seenSlugs.add(slug);
  seenLabels.add(label);
  const tokenKeys = Object.keys(tokens).sort();
  const expectedKeys = [...requiredTokenKeys].sort();
  if (JSON.stringify(tokenKeys) !== JSON.stringify(expectedKeys)) throw new Error(`Invalid token schema in ${file}`);
  for (const [key, value] of Object.entries(tokens)) {
    if (!/^#[0-9A-Fa-f]{6}$/.test(value)) throw new Error(`Invalid ${key} color in ${file}: ${value}`);
  }
  
  const channel = (offset) => parseInt(tokens.background.slice(offset, offset + 2), 16) / 255;
  const linear = (value) => value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  const luminance = 0.2126 * linear(channel(1)) + 0.7152 * linear(channel(3)) + 0.0722 * linear(channel(5));
  themes.push({ slug, label, isDark: luminance < 0.18, order: Number(themeData.order ?? 99) });
  
  let selectors = `:root[data-theme="${slug}"]`;
  if (slug === 'goldendefault') {
    selectors = `:root, :root:not([data-theme]), :root[data-theme="system"], :root[data-theme="${slug}"]`;
  }
  
  cssContent += `${selectors} {\n`;
  for (const key of requiredTokenKeys) {
    const value = tokens[key];
    cssContent += `  --${key}: ${value};\n`;
  }
  cssContent += `}\n\n`;
}

fs.writeFileSync(outputCssFile, cssContent);

themes.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
for (const t of themes) {
  tsContent += `  { slug: ${JSON.stringify(t.slug)}, label: ${JSON.stringify(t.label)}, isDark: ${t.isDark} },\n`;
}
tsContent += `]\n`;
fs.writeFileSync(outputTsFile, tsContent);

console.log(`Generated Wintage themes (${themes.length} themes).`);
