export function parseTextGrid(text) {
  const lines = text.split(/\r?\n/);
  let duration = 70;
  const tiers = {};
  let i = 0;

  // Find xmax at top level for duration
  for (let j = 0; j < Math.min(20, lines.length); j++) {
    const m = lines[j].match(/^xmax\s*=\s*([\d.]+)/);
    if (m) { duration = parseFloat(m[1]); break; }
  }

  // Parse tiers
  while (i < lines.length) {
    const tierMatch = lines[i].match(/^\s*item\s*\[(\d+)\]\s*:/);
    if (tierMatch) {
      i++;
      let tierName = null;
      const items = [];
      while (i < lines.length && !lines[i].match(/^\s*item\s*\[\d+\]\s*:/)) {
        const nameLine = lines[i].match(/^\s*name\s*=\s*"(.*)"/);
        if (nameLine) tierName = nameLine[1];

        const intMatch = lines[i].match(/^\s*intervals\s*\[(\d+)\]\s*:/);
        if (intMatch) {
          i++;
          let xmin = 0, xmax = 0, text = '';
          while (i < lines.length && !lines[i].match(/^\s*intervals\s*\[\d+\]\s*:/)) {
            const xminM = lines[i].match(/^\s*xmin\s*=\s*([\d.]+)/);
            const xmaxM = lines[i].match(/^\s*xmax\s*=\s*([\d.]+)/);
            const textM = lines[i].match(/^\s*text\s*=\s*"(.*)"/);
            if (xminM) xmin = parseFloat(xminM[1]);
            if (xmaxM) xmax = parseFloat(xmaxM[1]);
            if (textM) text = textM[1];
            i++;
            if (lines[i] && (lines[i].match(/^\s*intervals\s*\[\d+\]\s*:/) ||
                lines[i].match(/^\s*item\s*\[\d+\]\s*:/) ||
                lines[i].match(/^\s*points\s*\[/))) break;
          }
          if (text.trim()) items.push({ t0: xmin, t1: xmax, text: text.trim() });
          continue;
        }
        i++;
      }
      if (tierName) tiers[tierName] = items;
      continue;
    }
    i++;
  }

  return { duration, tiers };
}
