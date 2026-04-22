import { AlertTriangle, Bell, Lock, ShieldCheck, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { AuditLog } from "../types";

type AdminViewProps = {
  locked: boolean;
  setLocked: (value: boolean) => void;
  auditLogs: AuditLog[];
};

export function AdminView({ locked, setLocked, auditLogs }: AdminViewProps) {
  const roles = [
    ["Dealer", "Rake, tips, insurance entry"],
    ["Cashier", "Buy-in, cash-out, cash handling"],
    ["Manager", "Approvals, credit, daily close"],
    ["Admin", "Branch, tables, roles, audit logs"],
  ];
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle>Staff roles</CardTitle>
          <CardDescription>
            Dealer, Cashier, Manager, and Admin sample permissions
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {roles.map(([role, access]) => (
            <div
              key={role}
              className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="font-medium">{role}</p>
                <p className="text-sm text-muted-foreground">{access}</p>
              </div>
              <ShieldCheck className="size-5 text-emerald-700" />
            </div>
          ))}
        </CardContent>
      </Card>
      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle>Branch and table settings</CardTitle>
          <CardDescription>Operational limits and end-of-day controls</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border p-3">
              <Users className="mb-2 size-5 text-sky-700" />
              <p className="font-medium">Max seats</p>
              <p className="text-sm text-muted-foreground">9 players per table</p>
            </div>
            <div className="rounded-lg border p-3">
              <Bell className="mb-2 size-5 text-amber-700" />
              <p className="font-medium">Summary push</p>
              <p className="text-sm text-muted-foreground">Every 30 minutes</p>
            </div>
          </div>
          <Button
            className="w-full sm:w-auto"
            variant={locked ? "secondary" : "destructive"}
            onClick={() => {
              if (
                window.confirm(
                  locked
                    ? "Unlock this sample day?"
                    : "Lock the day and block further edits?",
                )
              ) {
                setLocked(!locked);
              }
            }}
          >
            <Lock /> {locked ? "Unlock sample day" : "Lock day"}
          </Button>
        </CardContent>
      </Card>
      <Card className="rounded-lg xl:col-span-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4" /> Activity logs
          </CardTitle>
          <CardDescription>Every operational action can be audited</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          {auditLogs.slice(0, 8).map((log) => (
            <div key={log.id} className="rounded-lg border p-3 text-sm">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <p className="font-medium">{log.action}</p>
                <p className="text-xs text-muted-foreground">{log.time}</p>
              </div>
              <p className="text-muted-foreground">
                {log.actor} | {log.entity} | {log.reason}
              </p>
              {(log.before || log.after) && (
                <p className="text-xs text-muted-foreground">
                  {log.before ? `Before: ${log.before}` : ""}
                  {log.before && log.after ? " | " : ""}
                  {log.after ? `After: ${log.after}` : ""}
                </p>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
