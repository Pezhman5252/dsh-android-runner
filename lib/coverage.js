import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
function walk(dir, files, depth) {
    if (depth > 6)
        return;
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory())
            walk(p, files, depth + 1);
        else if (e.isFile() && /jacoco.*\.xml$/i.test(e.name))
            files.push(p);
    }
}
function attr(tag, name) {
    const match = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
    return match ? match[1] ?? '' : '';
}
function counter(xml, type) {
    const re = new RegExp(`<counter\\b[^>]*type=["']${type}["'][^>]*/?>`, 'gi');
    let last = null;
    let m;
    while ((m = re.exec(xml)) !== null)
        last = m[0];
    if (!last)
        return null;
    const covered = attr(last, 'covered');
    const missed = attr(last, 'missed');
    if (covered === '' || missed === '')
        return null;
    return { covered: Number(covered), missed: Number(missed) };
}
export function collectCoverage(projectRoot, modules) {
    const files = [];
    for (const module of modules) {
        const rel = module.slice(1).split(':').filter(Boolean).join('/');
        walk(join(projectRoot, rel, 'build', 'reports', 'jacoco'), files, 0);
    }
    const unique = [...new Set(files)];
    if (!unique.length)
        return { available: false, linePercent: -1, branchPercent: -1, instructionPercent: -1, methodPercent: -1, classPercent: -1, reportFiles: 0 };
    const sums = new Map();
    for (const file of unique) {
        try {
            const xml = readFileSync(file, 'utf8');
            for (const type of ['LINE', 'BRANCH', 'INSTRUCTION', 'METHOD', 'CLASS']) {
                const value = counter(xml, type);
                if (value) {
                    const current = sums.get(type) ?? { covered: 0, missed: 0 };
                    current.covered += value.covered;
                    current.missed += value.missed;
                    sums.set(type, current);
                }
            }
        }
        catch { }
    }
    const pct = (type) => { const v = sums.get(type); if (!v)
        return -1; const total = v.covered + v.missed; return total ? (v.covered / total) * 100 : 100; };
    return { available: true, linePercent: pct('LINE'), branchPercent: pct('BRANCH'), instructionPercent: pct('INSTRUCTION'), methodPercent: pct('METHOD'), classPercent: pct('CLASS'), reportFiles: unique.length };
}
