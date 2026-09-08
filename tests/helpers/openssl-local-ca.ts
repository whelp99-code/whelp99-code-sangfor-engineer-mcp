import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function openssl(args: readonly string[]): void {
  execFileSync('openssl', [...args], { stdio: 'pipe' });
}

/** An explicit CA validity window in OpenSSL `YYYYMMDDHHMMSSZ` form. */
export type CaWindow = { readonly notBefore?: string; readonly notAfter?: string };

export type LeafInput = {
  readonly caRoot: string;
  readonly name: string;
  readonly commonName: string;
  readonly eku: string;
  readonly san: string;
};

export type IssuedLeaf = { readonly certPath: string; readonly keyPath: string };

/**
 * Stands up a real self-signed CA database under `<root>/<name>`.
 *
 * `req -x509` only learns `-not_before` / `-not_after` in OpenSSL 3.5, so an
 * explicit window is set through `ca -selfsign -startdate/-enddate`, which every
 * supported release accepts. The CA extensions therefore have to be supplied by
 * the config file rather than by `req`.
 */
export function createCa(root: string, name: string, window: CaWindow = {}): string {
  const caRoot = join(root, name);
  mkdirSync(join(caRoot, 'newcerts'), { recursive: true });
  writeFileSync(join(caRoot, 'index.txt'), '');
  writeFileSync(join(caRoot, 'index.txt.attr'), 'unique_subject = no\n');
  writeFileSync(join(caRoot, 'serial'), '2000\n');
  writeFileSync(join(caRoot, 'ca.cnf'), [
    '[ca]', 'default_ca=local_ca', '[local_ca]', `database=${join(caRoot, 'index.txt')}`,
    `serial=${join(caRoot, 'serial')}`, `new_certs_dir=${join(caRoot, 'newcerts')}`,
    `certificate=${join(caRoot, 'ca.crt')}`, `private_key=${join(caRoot, 'ca.key')}`,
    'default_md=sha256', 'policy=subject_policy', 'copy_extensions=copy',
    'x509_extensions=ca_extensions', '[subject_policy]', 'commonName=supplied',
    '[ca_extensions]', 'basicConstraints=critical,CA:TRUE',
    'keyUsage=critical,keyCertSign,cRLSign', 'subjectKeyIdentifier=hash',
    'authorityKeyIdentifier=keyid:always',
  ].join('\n'));
  openssl([
    'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-out', join(caRoot, 'ca.key'),
  ]);
  openssl([
    'req', '-new', '-key', join(caRoot, 'ca.key'), '-subj', `/CN=${name}`,
    '-out', join(caRoot, 'ca.csr'),
  ]);
  openssl([
    'ca', '-selfsign', '-batch', '-notext', '-config', join(caRoot, 'ca.cnf'),
    '-in', join(caRoot, 'ca.csr'), '-out', join(caRoot, 'ca.crt'),
    ...(window.notBefore === undefined
      ? ['-days', '3650']
      : ['-startdate', window.notBefore, '-enddate', window.notAfter ?? window.notBefore]),
  ]);
  return caRoot;
}

export function issueLeaf(input: LeafInput): IssuedLeaf {
  const keyPath = join(input.caRoot, `${input.name}.key`);
  const csrPath = join(input.caRoot, `${input.name}.csr`);
  const certPath = join(input.caRoot, `${input.name}.crt`);
  const extPath = join(input.caRoot, `${input.name}.ext`);
  writeFileSync(extPath, [
    'basicConstraints=CA:FALSE',
    'keyUsage=digitalSignature,keyEncipherment',
    `extendedKeyUsage=${input.eku}`,
    `subjectAltName=${input.san}`,
  ].join('\n'));
  openssl([
    'req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-subj', `/CN=${input.commonName}`, '-keyout', keyPath, '-out', csrPath,
  ]);
  openssl([
    'ca', '-batch', '-notext', '-config', join(input.caRoot, 'ca.cnf'),
    '-in', csrPath, '-out', certPath, '-days', '3650', '-extfile', extPath,
  ]);
  chmodSync(keyPath, 0o600);
  return { certPath, keyPath };
}

export function certificateFingerprint256(certPath: string): string {
  const output = execFileSync('openssl',
    ['x509', '-in', certPath, '-noout', '-fingerprint', '-sha256'], { encoding: 'utf8' });
  return output.split('=')[1]?.replaceAll(':', '').trim().toLowerCase() ?? '';
}

export function certificateSerial(certPath: string): string {
  const output = execFileSync('openssl',
    ['x509', '-in', certPath, '-noout', '-serial'], { encoding: 'utf8' });
  return output.split('=')[1]?.trim().toUpperCase() ?? '';
}
