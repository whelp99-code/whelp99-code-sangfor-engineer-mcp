import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as jmAgent from '../packages/sangfor-jm-agent/src/index.js';

const ROOT = join(import.meta.dirname, '..');
const APP_ROOT = join(ROOT, 'apps/jm-browser-agent/src');
const PACKAGE_ROOT = join(ROOT, 'packages/sangfor-jm-agent/src');

type Source = { readonly name: string; readonly text: string };

function sourcesUnder(root: string): readonly Source[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => ({ name: entry.name, text: readFileSync(join(root, entry.name), 'utf8') }));
}

function pureLoc(text: string): number {
  return text.split('\n')
    .filter((line) => line.trim().length > 0 && !/^\s*(\/\/|\/\*|\*)/u.test(line))
    .length;
}

describe('JM cannot mint authority (static export boundary)', () => {
  it('exports no signer and no private-key API from the JM package', () => {
    // Given the complete public surface of the JM package.
    const exported = Object.keys(jmAgent);

    // Then nothing that could mint authority is reachable.
    for (const forbidden of ['signAuthorityReceipt', 'signGrantSnapshot', 'mintJobCapability']) {
      expect(exported, `${forbidden} must not be exported`).not.toContain(forbidden);
    }
    expect(exported.filter((name) => /^sign|^mint|PrivateKey/u.test(name))).toEqual([]);
  });

  it('never imports a private-key or signing primitive anywhere in JM', () => {
    const sources = [...sourcesUnder(APP_ROOT), ...sourcesUnder(PACKAGE_ROOT)];

    for (const source of sources) {
      // Inspect the IMPORT bindings only: prose may say "signature", but no JM
      // module may bind `sign`, `createPrivateKey`, or a key generator.
      const imported = [...source.text.matchAll(/import\s*\{([^}]*)\}\s*from/gu)]
        .flatMap((match) => (match[1] ?? '').split(','))
        .map((binding) => binding.replace(/\btype\b/u, '').trim().split(/\s+as\s+/u)[0]);
      for (const minting of ['sign', 'createPrivateKey', 'generateKeyPairSync', 'generateKeyPair']) {
        expect(imported, `${source.name} must not import ${minting}`).not.toContain(minting);
      }
      // Match the import SPECIFIER, not any string that happens to contain the
      // word (the receipt header is literally x-sangfor-authority-receipt).
      const specifiers = [...source.text.matchAll(/from\s+'([^']+)'/gu)]
        .map((match) => match[1] ?? '');
      expect(
        specifiers.filter((value) => /sangfor-authority|@sangfor\/authority/u.test(value)),
        `${source.name} must not import the authority package`,
      ).toEqual([]);
    }
  });

  it('keeps the BLRO-side signer inside the authority package only', () => {
    const signer = readFileSync(
      join(ROOT, 'packages/sangfor-authority/src/jm-authority-signing.ts'), 'utf8',
    );

    expect(signer).toContain('signJmAuthorityArtifact');
    expect(signer).toContain('createPrivateKey');
    // And no JM source reaches it.
    for (const source of [...sourcesUnder(APP_ROOT), ...sourcesUnder(PACKAGE_ROOT)]) {
      expect(source.text, source.name).not.toContain('signJmAuthorityArtifact');
    }
  });
});

describe('production never creates its own journal', () => {
  it('has no mkdir or file-creation call in the journal or the runtime', () => {
    for (const name of ['refusal-journal.ts', 'journal-storage.ts', 'runtime.ts']) {
      const source = readFileSync(join(PACKAGE_ROOT, name), 'utf8');
      expect(source, `${name} must not create a journal`)
        .not.toMatch(/mkdirSync|writeFileSync|renameSync|chmodSync/u);
    }
  });

  it('keeps the operator initialiser outside every app and package import', () => {
    for (const source of [...sourcesUnder(APP_ROOT), ...sourcesUnder(PACKAGE_ROOT)]) {
      expect(source.text, `${source.name} must not import the init CLI`)
        .not.toContain('jm-journal-init');
    }
    // And the CLI itself demands a signed grant plus an explicit --apply.
    const cli = readFileSync(join(ROOT, 'scripts/jm-journal-init.ts'), 'utf8');
    expect(cli).toContain('verifyGrantSnapshot');
    expect(cli).toContain("--apply");
    expect(cli).toContain('appendDurably');
  });
});

describe('JM has no mock execution path in production', () => {
  it('ships no mock execution module in the package or the app', () => {
    const names = [...sourcesUnder(APP_ROOT), ...sourcesUnder(PACKAGE_ROOT)]
      .map((source) => source.name);

    expect(names).not.toContain('mock-execution.ts');
    expect(Object.keys(jmAgent)).not.toContain('createMockJmExecutionPort');
  });

  it('has no execution-mode switch or mock branch in any JM source', () => {
    for (const source of [...sourcesUnder(APP_ROOT), ...sourcesUnder(PACKAGE_ROOT)]) {
      // The only permitted mention is the forbidden-field list that refuses it.
      // Strip comments and quoted strings first: naming or documenting the
      // refusal is not the same as branching on a mock mode.
      const offending = source.text
        .replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '')
        .replaceAll(/'[^']*'|"[^"]*"|`[^`]*`/gu, "''")
        .split('\n')
        .filter((line) => /\bmock\b/iu.test(line));
      expect(offending, `${source.name} must not branch on a mock mode`).toEqual([]);
    }
  });

  it('builds the operated jm-execution port as the only production factory', () => {
    const operated = readFileSync(join(APP_ROOT, 'operated-execution.ts'), 'utf8');

    expect(operated).toContain('sangfor-jm-execution');
    expect(operated).toContain('createPlaywrightJmBrowserDriver');
    expect(readFileSync(join(APP_ROOT, 'composition.ts'), 'utf8'))
      .toContain('createOperatedExecutionPort');
  });
});

describe('JM architecture boundary', () => {
  it('never imports a database, ORM, SQL, or BLRO authority mutation surface', () => {
    const sources = [...sourcesUnder(APP_ROOT), ...sourcesUnder(PACKAGE_ROOT)];
    const forbidden = [
      'PrismaClient', '@prisma/client', '$queryRaw', '$executeRaw', '$transaction',
      'DATABASE_URL', 'postgres://', 'postgresql://',
      'PostgresRemoteJobStore', 'PostgresEnrollmentRegistry',
    ];

    for (const source of sources) {
      for (const token of forbidden) {
        expect(source.text, `${source.name} must not reference ${token}`).not.toContain(token);
      }
    }
  });

  it('persists no credential or session state, only the refusal journal', () => {
    for (const source of sourcesUnder(APP_ROOT)) {
      expect(source.text, `${source.name} must not write files`)
        .not.toMatch(/writeFileSync|appendFileSync|createWriteStream/u);
    }
    // The journal is the ONE writer, and it records no secret.
    const journal = readFileSync(join(PACKAGE_ROOT, 'refusal-journal.ts'), 'utf8');
    const storage = readFileSync(join(PACKAGE_ROOT, 'journal-storage.ts'), 'utf8');
    expect(journal).not.toMatch(/privateKey|passphrase|certificate|credential/iu);
    // Durability lives in the storage module after the split.
    expect(storage).toContain('fsyncSync');
  });

  it('never returns an authoritative PASS from the JM dispatch path', () => {
    const store = readFileSync(join(PACKAGE_ROOT, 'receipt-job-store.ts'), 'utf8');

    expect(store).not.toMatch(/status: 'PASS'/u);
    expect(store).toMatch(/retainResult[\s\S]*?kind: 'indeterminate'/u);
  });

  it('uses HTTPS with mandatory mutual TLS and no permissive fallback', () => {
    const server = readFileSync(join(APP_ROOT, 'server.ts'), 'utf8');

    expect(server).toContain("from 'node:https'");
    expect(server).not.toMatch(/^import\s+(?!type)[^;]*from\s+'node:http'/mu);
    expect(server).toContain('requestCert: true');
    expect(server).toContain('rejectUnauthorized: true');
    expect(server).not.toMatch(/rejectUnauthorized:\s*false/u);
    expect(server).toContain("minVersion: 'TLSv1.2'");
  });

  it('drains on event barriers with no sleep, poll, or retry loop', () => {
    for (const source of [...sourcesUnder(APP_ROOT), ...sourcesUnder(PACKAGE_ROOT)]) {
      expect(source.text, `${source.name} must not sleep or poll`)
        .not.toMatch(/setTimeout\(|setInterval\(|while\s*\(true\)/u);
    }
    expect(readFileSync(join(PACKAGE_ROOT, 'in-flight.ts'), 'utf8'))
      .toContain('signal.addEventListener');
  });

  it('reads process.env only in the entrypoint', () => {
    const offenders = sourcesUnder(APP_ROOT)
      .filter((source) => source.name !== 'index.ts')
      .filter((source) => source.text
        .replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '')
        .includes('process.env'));

    expect(offenders.map((source) => source.name)).toEqual([]);
  });

  it('keeps every app file thin and every module inside the size ceiling', () => {
    for (const source of sourcesUnder(APP_ROOT)) {
      expect(pureLoc(source.text), `${source.name} must stay a thin adapter`)
        .toBeLessThanOrEqual(110);
    }
    for (const source of sourcesUnder(PACKAGE_ROOT)) {
      expect(pureLoc(source.text), `${source.name} exceeds the 250 pure LOC ceiling`)
        .toBeLessThanOrEqual(250);
    }
  });
});
