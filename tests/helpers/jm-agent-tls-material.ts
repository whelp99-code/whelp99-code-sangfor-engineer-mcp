import { join } from 'node:path';
import { JM_INSTALLATION_ID } from './jm-agent-identity.js';
import {
  certificateFingerprint256,
  certificateSerial,
  createCa,
  issueLeaf,
} from './openssl-local-ca.js';

export type JmTlsMaterial = {
  readonly caPath: string;
  readonly serverCertPath: string;
  readonly serverKeyPath: string;
  readonly clientCertPath: string;
  readonly clientKeyPath: string;
  readonly foreignClientCertPath: string;
  readonly foreignClientKeyPath: string;
  readonly otherServerCertPath: string;
  readonly otherServerKeyPath: string;
  /** A leaf that carries clientAuth only: must be refused as a server identity. */
  readonly clientAuthOnlyCertPath: string;
  readonly clientAuthOnlyKeyPath: string;
  /** A serverAuth leaf whose SAN is not loopback. */
  readonly nonLoopbackServerCertPath: string;
  readonly nonLoopbackServerKeyPath: string;
  /** A serverAuth loopback leaf from a DIFFERENT CA. */
  readonly foreignServerCertPath: string;
  readonly foreignServerKeyPath: string;
  readonly foreignCaPath: string;
  /** CAs outside their own validity window; leaves under them still verify. */
  readonly expiredCaPath: string;
  readonly futureCaPath: string;
  readonly clientFingerprint256: string;
  readonly clientSerial: string;
  readonly clientSubjectAltName: string;
};

export function createJmTlsMaterial(root: string): JmTlsMaterial {
  const trusted = createCa(root, 'Task26-Trusted-CA');
  const foreign = createCa(root, 'Task26-Foreign-CA');
  const expiredCa = createCa(root, 'Task26-Expired-CA', {
    notBefore: '20200101000000Z', notAfter: '20210101000000Z',
  });
  const futureCa = createCa(root, 'Task26-Future-CA', {
    notBefore: '20400101000000Z', notAfter: '20410101000000Z',
  });
  const loopbackSan = 'IP:127.0.0.1,DNS:localhost';
  const server = issueLeaf({
    caRoot: trusted, name: 'server', commonName: 'jm-browser-agent',
    eku: 'serverAuth', san: loopbackSan,
  });
  const otherServer = issueLeaf({
    caRoot: trusted, name: 'server-other', commonName: 'jm-browser-agent-other',
    eku: 'serverAuth', san: loopbackSan,
  });
  const clientAuthOnly = issueLeaf({
    caRoot: trusted, name: 'server-clientauth', commonName: 'jm-browser-agent',
    eku: 'clientAuth', san: loopbackSan,
  });
  const nonLoopback = issueLeaf({
    caRoot: trusted, name: 'server-public', commonName: 'jm-browser-agent',
    eku: 'serverAuth', san: 'DNS:agent.example.invalid',
  });
  const foreignServer = issueLeaf({
    caRoot: foreign, name: 'server-foreign', commonName: 'jm-browser-agent',
    eku: 'serverAuth', san: loopbackSan,
  });
  const clientSan = `URI:urn:sangfor:installation:${JM_INSTALLATION_ID}`;
  const client = issueLeaf({
    caRoot: trusted, name: 'blro-client', commonName: 'blro-control-tower',
    eku: 'clientAuth', san: clientSan,
  });
  const foreignClient = issueLeaf({
    caRoot: foreign, name: 'foreign-client', commonName: 'blro-control-tower',
    eku: 'clientAuth', san: clientSan,
  });
  return {
    caPath: join(trusted, 'ca.crt'),
    foreignCaPath: join(foreign, 'ca.crt'),
    expiredCaPath: join(expiredCa, 'ca.crt'),
    futureCaPath: join(futureCa, 'ca.crt'),
    serverCertPath: server.certPath,
    serverKeyPath: server.keyPath,
    otherServerCertPath: otherServer.certPath,
    otherServerKeyPath: otherServer.keyPath,
    clientAuthOnlyCertPath: clientAuthOnly.certPath,
    clientAuthOnlyKeyPath: clientAuthOnly.keyPath,
    nonLoopbackServerCertPath: nonLoopback.certPath,
    nonLoopbackServerKeyPath: nonLoopback.keyPath,
    foreignServerCertPath: foreignServer.certPath,
    foreignServerKeyPath: foreignServer.keyPath,
    clientCertPath: client.certPath,
    clientKeyPath: client.keyPath,
    foreignClientCertPath: foreignClient.certPath,
    foreignClientKeyPath: foreignClient.keyPath,
    clientFingerprint256: certificateFingerprint256(client.certPath),
    clientSerial: certificateSerial(client.certPath),
    clientSubjectAltName: `urn:sangfor:installation:${JM_INSTALLATION_ID}`,
  };
}
