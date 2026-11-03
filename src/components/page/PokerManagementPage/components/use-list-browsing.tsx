"use client";

import {
  listSortOptions,
  readSortQuery,
  sortLocalRecords,
  validListSort,
  type ListSortResource,
} from "@/domain/list-sort";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { ListOrderControls } from "./list-order-controls";
import type { ListSorting } from "./sortable-table-head";
import { useText } from "./shared";

/** Browsing preferences share the existing access-scoped read draft boundary.
 * Form values and financial retry/revision state do not pass through this hook.
 */
export function useListBrowsing(
  resource: ListSortResource,
  prefix: string,
  keys: {
    page?: string;
    pageSize?: string;
    sort?: string;
    direction?: string;
    label?: string;
  } = {},
) {
  const s = usePokerManagementContext();
  const t = useText();
  const key = (name: "page" | "pageSize" | "sort" | "direction") =>
    `${prefix}.${keys[name] ?? name}`;
  const pageSize = s.draft(key("pageSize"), "20") === "50" ? 50 : 20;
  const requestedSort = s.draft(key("sort"));
  const sort = validListSort(resource, requestedSort) ? requestedSort : "";
  const direction = s.draft(key("direction")) === "desc" ? "desc" : "asc";
  const sorting: ListSorting = {
    value: sort,
    direction,
    options: listSortOptions(resource),
    onChange(value, order) {
      if (value && !validListSort(resource, value)) return;
      s.setDraft(key("sort"), value);
      s.setDraft(key("direction"), value ? order : "");
      s.setDraft(key("page"), "0");
    },
  };
  return {
    sorting,
    pageSize,
    query: { pageSize, ...readSortQuery(sort, direction) },
    sortRows: <T,>(rows: readonly T[]) =>
      sortLocalRecords(resource, rows, sort, direction),
    pager: {
      pageSize,
      onPageSizeChange: (value: number) =>
        s.setDraft(key("pageSize"), String(value)),
    },
    controls: (
      <ListOrderControls
        options={listSortOptions(resource)}
        value={sorting.value}
        direction={sorting.direction}
        onChange={sorting.onChange}
        label={keys.label}
        t={t}
      />
    ),
  };
}
