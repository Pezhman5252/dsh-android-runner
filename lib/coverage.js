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
function counter(xml, type) {
    const m = new RegExp(`<counter\\b[^>]*type=["']${type}["'][^>]*covered=["'](\\d+)["'][^>]*missed=["'](\\d+)["'][^>]*/?>`, 'i').exec(xml);
    if (!m)
        return null;
    const covered = Number(m[1]), missed = Number(m[2]), total = covered + missed;
    return total > 0 ? (covered / total) * 100 : 100;
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
                const re = new RegExp(`<counter\\b[^>]*type=["']${type}["'][^>]*covered=["'](\\d+)["'][^>]*missed=["'](\\d+)["'][^>]*/?>`, 'i').exec(xml);
                if (re) {
                    const current = sums.get(type) ?? { covered: 0, missed: 0 };
                    current.covered += Number(re[1]);
                    current.missed += Number(re[2]);
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
