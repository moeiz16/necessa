"use client";

import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Columns3 } from "lucide-react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Checkbox } from "./controls";
import { Dropdown, DropdownContent, DropdownLabel, DropdownTrigger } from "./overlays";
import { DropdownMenu as DM } from "radix-ui";

export interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  onRowClick?: (row: T) => void;
  selectable?: boolean;
  onSelectionChange?: (rows: T[]) => void;
  getRowId?: (row: T) => string;
  globalFilter?: string;
  pageSize?: number;
  empty?: React.ReactNode;
  toolbar?: React.ReactNode;
  initialSorting?: SortingState;
  initialHidden?: VisibilityState;
  dense?: boolean;
  className?: string;
  rowClassName?: (row: T) => string | undefined;
}

export function DataTable<T>({
  data,
  columns,
  onRowClick,
  selectable,
  onSelectionChange,
  getRowId,
  globalFilter,
  pageSize = 25,
  empty,
  toolbar,
  initialSorting = [],
  initialHidden = {},
  dense,
  className,
  rowClassName,
}: DataTableProps<T>) {
  const [sorting, setSorting] = React.useState<SortingState>(initialSorting);
  const [visibility, setVisibility] = React.useState<VisibilityState>(initialHidden);
  const [selection, setSelection] = React.useState<RowSelectionState>({});

  const cols = React.useMemo<ColumnDef<T, unknown>[]>(() => {
    if (!selectable) return columns;
    return [
      {
        id: "__select",
        enableSorting: false,
        enableHiding: false,
        size: 36,
        header: ({ table }) => (
          <Checkbox
            aria-label="Select all"
            checked={table.getIsAllPageRowsSelected() ? true : table.getIsSomePageRowsSelected() ? "indeterminate" : false}
            onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)}
          />
        ),
        cell: ({ row }) => (
          <Checkbox aria-label="Select row" checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(!!v)} onClick={(e) => e.stopPropagation()} />
        ),
      },
      ...columns,
    ];
  }, [columns, selectable]);

  const table = useReactTable({
    data,
    columns: cols,
    state: { sorting, columnVisibility: visibility, rowSelection: selection, globalFilter },
    getRowId,
    onSortingChange: setSorting,
    onColumnVisibilityChange: setVisibility,
    onRowSelectionChange: setSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  });

  const selectedRows = table.getSelectedRowModel().rows;
  React.useEffect(() => {
    onSelectionChange?.(selectedRows.map((r) => r.original));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection]);

  const rows = table.getRowModel().rows;
  const pageCount = table.getPageCount();

  return (
    <div className={cn("overflow-hidden rounded-xl bg-surface shadow-e1", className)}>
      {toolbar !== undefined ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{toolbar}</div>
          <Dropdown>
            <DropdownTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Toggle columns">
                <Columns3 />
                <span className="hidden sm:inline">Columns</span>
              </Button>
            </DropdownTrigger>
            <DropdownContent>
              <DropdownLabel>Visible columns</DropdownLabel>
              {table
                .getAllLeafColumns()
                .filter((c) => c.getCanHide())
                .map((c) => (
                  <DM.CheckboxItem
                    key={c.id}
                    checked={c.getIsVisible()}
                    onCheckedChange={(v) => c.toggleVisibility(!!v)}
                    onSelect={(e) => e.preventDefault()}
                    className="relative flex cursor-default select-none items-center gap-2 rounded-sm py-1.5 pl-7 pr-2 text-[13px] outline-none data-[highlighted]:bg-surface-2"
                  >
                    <DM.ItemIndicator className="absolute left-2 text-brand">✓</DM.ItemIndicator>
                    {typeof c.columnDef.header === "string" ? c.columnDef.header : c.id}
                  </DM.CheckboxItem>
                ))}
            </DropdownContent>
          </Dropdown>
        </div>
      ) : null}
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full border-separate border-spacing-0 text-[13px]">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const sorted = h.column.getIsSorted();
                  return (
                    <th
                      key={h.id}
                      style={{ width: h.column.columnDef.size !== 150 ? h.column.columnDef.size : undefined }}
                      className="sticky top-0 z-[1] whitespace-nowrap border-b border-border bg-surface px-3 py-2 text-left text-xs font-medium text-muted"
                    >
                      {h.isPlaceholder ? null : h.column.getCanSort() ? (
                        <button
                          type="button"
                          onClick={h.column.getToggleSortingHandler()}
                          className="inline-flex items-center gap-1 rounded-sm hover:text-fg"
                          aria-label={`Sort by ${String(h.column.columnDef.header ?? h.id)}`}
                        >
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {sorted === "asc" ? <ArrowUp className="size-3" /> : sorted === "desc" ? <ArrowDown className="size-3" /> : null}
                        </button>
                      ) : (
                        flexRender(h.column.columnDef.header, h.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={cols.length} className="px-3">
                  {empty}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={row.id}
                  data-selected={row.getIsSelected() || undefined}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === "Enter") onRowClick(row.original);
                        }
                      : undefined
                  }
                  tabIndex={onRowClick ? 0 : undefined}
                  className={cn(
                    "group outline-none transition-colors data-[selected]:bg-brand-soft/40",
                    onRowClick && "cursor-pointer hover:bg-surface-2/70 focus-visible:bg-surface-2",
                    rowClassName?.(row.original),
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className={cn("border-b border-border/70 px-3 align-middle group-last:border-b-0", dense ? "py-1.5" : "py-2.5")}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {pageCount > 1 ? (
        <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted">
          <span className="tabular">
            {table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1}–
            {Math.min(table.getFilteredRowModel().rows.length, (table.getState().pagination.pageIndex + 1) * table.getState().pagination.pageSize)} of{" "}
            {table.getFilteredRowModel().rows.length}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} aria-label="Previous page">
              <ChevronLeft />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} aria-label="Next page">
              <ChevronRight />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
