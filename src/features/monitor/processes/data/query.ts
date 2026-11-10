import type { RemoteProcess } from "@/lib/api/types";
import type { FrontendProcessSort } from "@/lib/extensions/contracts/monitor/processes/query";
import { matchesSearch, matchesSearchNumber, parseSearchQuery } from "@/lib/search/query";

import { knownProcessMetric } from "@/lib/monitor/processes/model";

export function queryProcesses(
  items: readonly RemoteProcess[],
  query: string,
  sort: FrontendProcessSort,
  language?: string,
): RemoteProcess[] {
  const search = parseSearchQuery(query, ["name", "pid", "user", "group", "cpu", "memory"]);
  return items
    .filter((process) =>
      matchesSearch(
        search,
        [
          process.name,
          process.pid,
          process.userName,
          process.groupName,
          process.uid,
          process.gid,
        ].join(" "),
        {
          name: (value) => process.name.toLocaleLowerCase().includes(value),
          pid: (value) => matchesSearchNumber(process.pid, value),
          user: [process.userName, process.uid],
          group: [process.groupName, process.gid],
          cpu: (value) =>
            matchesSearchNumber(
              knownProcessMetric(process.cpuTotal) ? process.cpuTotal : undefined,
              value,
            ),
          memory: (value) =>
            matchesSearchNumber(knownProcessMetric(process.rss) ? process.rss : undefined, value),
        },
      ),
    )
    .sort((left, right) => {
      const numeric = sort.key !== "name" && sort.key !== "userName";
      const a = left[sort.key],
        b = right[sort.key];
      const validA = numeric ? knownProcessMetric(a) : a != null;
      const validB = numeric ? knownProcessMetric(b) : b != null;
      if (!validA && !validB) return left.pid - right.pid;
      if (!validA) return 1;
      if (!validB) return -1;
      const difference =
        typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b), language, { numeric: true });
      return (sort.descending ? -difference : difference) || left.pid - right.pid;
    });
}
