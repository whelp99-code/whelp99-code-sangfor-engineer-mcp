export interface DrillCliOptions {
  readonly backupDir: string;
  readonly backupId: string;
  readonly publicKeyPath: string;
  readonly scratchTarget: string;
  readonly signingKeyPath: string;
  readonly evidenceRoot: string;
  readonly receiptOut: string | undefined;
}

export declare function parseDrillCli(argv: readonly string[]): DrillCliOptions;
export declare function runDrill(options: DrillCliOptions): Promise<void>;
