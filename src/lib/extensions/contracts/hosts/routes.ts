export interface HostConnectionRoute {
  proxy: string;
  jumpHosts: string[];
}

export interface HostRouteGetRequest {
  hostId: string;
}

export interface HostRouteSnapshot {
  hostId: string;
  revision: string;
  route: HostConnectionRoute;
}

export interface HostRouteSaveRequest extends HostRouteGetRequest {
  expectedRevision: string;
  route: HostConnectionRoute;
}

export interface HostRouteObserveRequest extends HostRouteGetRequest {
  revision?: string;
}

export type HostRouteObservation =
  | { revision: string; changed: true; snapshot: HostRouteSnapshot }
  | { revision: string; changed: false; snapshot: null };
