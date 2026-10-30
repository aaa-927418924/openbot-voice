declare module "proper-lockfile" {
  interface LockOptions {
    readonly realpath: false;
    readonly stale: number;
    readonly update: number;
    readonly retries: { readonly retries: number; readonly minTimeout: number; readonly maxTimeout: number };
  }

  type Release = () => Promise<void>;
  type Lock = (path: string, options: LockOptions) => Promise<Release>;

  const lock: Lock;
  export default lock;
}
