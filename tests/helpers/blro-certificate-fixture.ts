import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type TaskCertificateFixture = {
  readonly trustedCaPem: string;
  readonly foreignCaPem: string;
  readonly validPem: string;
  readonly validDerBase64: string;
  readonly middlePem: string;
  readonly newestPem: string;
  readonly changedSerialPem: string;
  readonly foreignPem: string;
  readonly unsignedPem: string;
  readonly cnOnlyPem: string;
  readonly wrongEkuPem: string;
  readonly expiredPem: string;
  readonly futurePem: string;
};
type IssueCertificate = {
  readonly caRoot: string;
  readonly name: string;
  readonly installationId: string;
  readonly deviceBindingDigest: string;
  readonly eku: 'clientAuth' | 'serverAuth';
  readonly sans: boolean;
  readonly start: string;
  readonly end: string;
  readonly serial?: string;
};

function run(args: readonly string[]): void {
  execFileSync('openssl', [...args], { stdio: 'pipe' });
}

function createCa(root: string, name: string): string {
  const caRoot = join(root, name);
  mkdirSync(join(caRoot, 'newcerts'), { recursive: true });
  writeFileSync(join(caRoot, 'index.txt'), '');
  writeFileSync(join(caRoot, 'index.txt.attr'), 'unique_subject = no\n');
  writeFileSync(join(caRoot, 'serial'), '1000\n');
  run([
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-days', '3650', '-subj', `/CN=${name}`, '-keyout', join(caRoot, 'ca.key'),
    '-out', join(caRoot, 'ca.crt'),
  ]);
  writeFileSync(join(caRoot, 'ca.cnf'), [
    '[ca]', 'default_ca=local_ca', '[local_ca]', `database=${join(caRoot, 'index.txt')}`,
    `serial=${join(caRoot, 'serial')}`, `new_certs_dir=${join(caRoot, 'newcerts')}`,
    `certificate=${join(caRoot, 'ca.crt')}`, `private_key=${join(caRoot, 'ca.key')}`,
    'default_md=sha256', 'policy=subject_policy', '[subject_policy]', 'commonName=supplied',
  ].join('\n'));
  return caRoot;
}

function selfSignedLeaf(input: Omit<IssueCertificate, 'caRoot' | 'start' | 'end' | 'serial'>, root: string): string {
  const key = join(root, `${input.name}.key`);
  const cert = join(root, `${input.name}.crt`);
  const san = `URI:urn:sangfor:installation:${input.installationId},URI:urn:sangfor:device-sha256:${input.deviceBindingDigest}`;
  run([
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-days', '1', '-subj', `/CN=${input.installationId}`, '-keyout', key, '-out', cert,
    '-addext', 'basicConstraints=CA:FALSE', '-addext', `extendedKeyUsage=${input.eku}`,
    ...(input.sans ? ['-addext', `subjectAltName=${san}`] : []),
  ]);
  return readFileSync(cert, 'utf8');
}

function issue(input: IssueCertificate): string {
  const key = join(input.caRoot, `${input.name}.key`);
  const csr = join(input.caRoot, `${input.name}.csr`);
  const cert = join(input.caRoot, `${input.name}.crt`);
  const ext = join(input.caRoot, `${input.name}.ext`);
  run([
    'req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-subj', `/CN=${input.installationId}`, '-keyout', key, '-out', csr,
  ]);
  const extensions = [
    'basicConstraints=CA:FALSE', 'keyUsage=digitalSignature', `extendedKeyUsage=${input.eku}`,
    ...(input.sans ? [`subjectAltName=URI:urn:sangfor:installation:${input.installationId},URI:urn:sangfor:device-sha256:${input.deviceBindingDigest}`] : []),
  ];
  writeFileSync(ext, extensions.join('\n'));
  if (input.serial) {
    const duplicateIndex = join(input.caRoot, `${input.name}.index`);
    const duplicateSerial = join(input.caRoot, `${input.name}.serial`);
    const duplicateConfig = join(input.caRoot, `${input.name}.cnf`);
    writeFileSync(duplicateIndex, '');
    writeFileSync(`${duplicateIndex}.attr`, 'unique_subject = no\n');
    writeFileSync(duplicateSerial, `${input.serial.replace(/^0x/u, '')}\n`);
    writeFileSync(duplicateConfig, [
      '[ca]', 'default_ca=local_ca', '[local_ca]', `database=${duplicateIndex}`,
      `serial=${duplicateSerial}`, `new_certs_dir=${join(input.caRoot, 'newcerts')}`,
      `certificate=${join(input.caRoot, 'ca.crt')}`, `private_key=${join(input.caRoot, 'ca.key')}`,
      'default_md=sha256', 'policy=subject_policy', '[subject_policy]', 'commonName=supplied',
    ].join('\n'));
    run([
      'ca', '-batch', '-notext', '-config', duplicateConfig, '-in', csr, '-out', cert,
      '-startdate', input.start, '-enddate', input.end, '-extfile', ext,
    ]);
  } else {
    run([
      'ca', '-batch', '-notext', '-config', join(input.caRoot, 'ca.cnf'), '-in', csr, '-out', cert,
      '-startdate', input.start, '-enddate', input.end, '-extfile', ext,
    ]);
  }
  return readFileSync(cert, 'utf8');
}

export function createTaskCertificateFixture(
  root: string,
  installationId: string,
  deviceBindingDigest: string,
): TaskCertificateFixture {
  const trusted = createCa(root, 'Task-21-Trusted-CA');
  const foreign = createCa(root, 'Task-21-Foreign-CA');
  const base = { installationId, deviceBindingDigest, eku: 'clientAuth' as const, sans: true,
    start: '20250825000000Z', end: '20350827000000Z' };
  const validPem = issue({ ...base, caRoot: trusted, name: 'valid' });
  const derPath = join(trusted, 'valid.der');
  run(['x509', '-in', join(trusted, 'valid.crt'), '-outform', 'DER', '-out', derPath]);
  return {
    trustedCaPem: readFileSync(join(trusted, 'ca.crt'), 'utf8'),
    foreignCaPem: readFileSync(join(foreign, 'ca.crt'), 'utf8'),
    validPem,
    validDerBase64: readFileSync(derPath).toString('base64'),
    middlePem: issue({ ...base, caRoot: trusted, name: 'middle' }),
    newestPem: issue({ ...base, caRoot: trusted, name: 'newest' }),
    changedSerialPem: issue({ ...base, caRoot: trusted, name: 'changed-serial', serial: '0x1002' }),
    foreignPem: issue({ ...base, caRoot: foreign, name: 'foreign' }),
    unsignedPem: selfSignedLeaf({ ...base, name: 'unsigned' }, trusted),
    cnOnlyPem: issue({ ...base, caRoot: trusted, name: 'cn-only', sans: false }),
    wrongEkuPem: issue({ ...base, caRoot: trusted, name: 'wrong-eku', eku: 'serverAuth' }),
    expiredPem: issue({ ...base, caRoot: trusted, name: 'expired', start: '20250825000000Z', end: '20250827000000Z' }),
    futurePem: issue({ ...base, caRoot: trusted, name: 'future', start: '20360825000000Z', end: '20360827000000Z' }),
  };
}
