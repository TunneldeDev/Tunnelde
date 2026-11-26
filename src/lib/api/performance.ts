/** Linux performance details from unprivileged remote sampling; unavailable values are null. */
export interface PerformanceDetails {
  cpuModel: string | null;
  cpuMhz: number | null;
  baseMhz: number | null;
  maxMhz: number | null;
  sockets: number | null;
  cores: number | null;
  cache: string | null;
  processes: number | null;
  threads: number | null;
  fileHandles: number | null;
  fileHandleLimit: number | null;
  memoryAvailable: number | null;
  memoryCached: number | null;
  memoryBuffers: number | null;
  memorySlab: number | null;
  memoryCommitted: number | null;
  memoryCommitLimit: number | null;
  pageTables: number | null;
  kernelStack: number | null;
  logicalCpus: { name: string; percent: number | null }[];
  disks: {
    name: string;
    model: string;
    capacity: number | null;
    rotational: boolean | null;
    readRate: number | null;
    writeRate: number | null;
    activePercent: number | null;
    responseMs: number | null;
  }[];
  networks: {
    name: string;
    rxRate: number | null;
    txRate: number | null;
    speedMbps: number | null;
    mac: string;
    state: string;
    addresses: string[];
  }[];
  gpus: {
    name: string;
    percent: number | null;
    memoryUsed: number | null;
    memoryTotal: number | null;
    temperature: number | null;
    driver: string;
  }[];
}
