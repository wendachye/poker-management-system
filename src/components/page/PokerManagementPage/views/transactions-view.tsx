import { CheckCircle2, CreditCard, Plus, ShieldCheck } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { txTypes } from "../data";
import type {
  BuyInForm,
  CashOutForm,
  ManualTxForm,
  Player,
  PokerTable,
  SetState,
  Transaction,
  TxType,
} from "../types";
import { money } from "../utils";
import { Badge, FormField, FormSelect } from "../components/shared";

type TransactionsViewProps = {
  activePlayers: Player[];
  tables: PokerTable[];
  buyIn: BuyInForm;
  setBuyIn: SetState<BuyInForm>;
  cashOut: CashOutForm;
  setCashOut: SetState<CashOutForm>;
  manualTx: ManualTxForm;
  setManualTx: SetState<ManualTxForm>;
  handleBuyIn: () => void;
  handleCashOut: () => void;
  handleManualTransaction: () => void;
  requestCorrection: (transactionId: string) => void;
  transactions: Transaction[];
  players: Player[];
};

export function TransactionsView({
  activePlayers,
  tables,
  buyIn,
  setBuyIn,
  cashOut,
  setCashOut,
  manualTx,
  setManualTx,
  handleBuyIn,
  handleCashOut,
  handleManualTransaction,
  requestCorrection,
  transactions,
  players,
}: TransactionsViewProps) {
  const cashOutPlayer = activePlayers.find(
    (player) => player.id === cashOut.playerId,
  );
  const cashOutAmount = Number(cashOut.amount);
  const plPreview = Number.isFinite(cashOutAmount)
    ? cashOutAmount - (cashOutPlayer?.buyIn || 0)
    : 0;

  return (
    <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
      <div className="space-y-4">
        <Alert variant="warning">
          <ShieldCheck className="size-4" />
          <AlertTitle>Approval required</AlertTitle>
          <AlertDescription>
            Cashier and dealer entries are queued first. Manager/Admin approval
            posts them to the ledger.
          </AlertDescription>
        </Alert>
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>Buy-in</CardTitle>
            <CardDescription>
              ACTIVE player only. CREDIT cannot exceed limit.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <FormField label="Active player">
              <FormSelect
                value={buyIn.playerId}
                onValueChange={(value) =>
                  setBuyIn((current) => ({ ...current, playerId: value }))
                }
                options={activePlayers.map((player) => ({
                  value: player.id,
                  label: `${player.name} | ${player.type}`,
                }))}
              />
            </FormField>
            <FormField label="Buy-in amount">
              <Input
                value={buyIn.amount}
                inputMode="decimal"
                onChange={(event) =>
                  setBuyIn((current) => ({ ...current, amount: event.target.value }))
                }
                placeholder="Amount"
              />
            </FormField>
            <Button className="w-full sm:w-auto" onClick={handleBuyIn}>
              <CreditCard /> Request buy-in approval
            </Button>
          </CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>Cash-out</CardTitle>
            <CardDescription>
              Total buy-in and P/L are calculated before OUT.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <FormField label="Active player">
              <FormSelect
                value={cashOut.playerId}
                onValueChange={(value) =>
                  setCashOut((current) => ({ ...current, playerId: value }))
                }
                options={activePlayers.map((player) => ({
                  value: player.id,
                  label: player.name,
                }))}
              />
            </FormField>
            <FormField label="Cash-out amount">
              <Input
                value={cashOut.amount}
                inputMode="decimal"
                onChange={(event) =>
                  setCashOut((current) => ({
                    ...current,
                    amount: event.target.value,
                  }))
                }
                placeholder="Cash-out amount"
              />
            </FormField>
            <div className="rounded-lg border p-3 text-sm">
              <p>Total buy-in: {money(cashOutPlayer?.buyIn || 0)}</p>
              <p>P/L preview: {money(plPreview)}</p>
            </div>
            <Button className="w-full sm:w-auto" onClick={handleCashOut}>
              <CheckCircle2 /> Request cash-out approval
            </Button>
          </CardContent>
        </Card>
        <Card className="rounded-lg">
          <CardHeader>
            <CardTitle>Manual entries</CardTitle>
            <CardDescription>
              Rake, JP, tips, insurance, cash received, and cash payout
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <FormField label="Transaction type">
              <FormSelect
                value={manualTx.type}
                onValueChange={(value) =>
                  setManualTx((current) => ({
                    ...current,
                    type: value as TxType,
                  }))
                }
                options={txTypes}
              />
            </FormField>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Table">
                <FormSelect
                  value={manualTx.tableId}
                  onValueChange={(value) =>
                    setManualTx((current) => ({ ...current, tableId: value }))
                  }
                  options={tables.map((table) => table.id)}
                />
              </FormField>
              <FormField label="Player">
                <FormSelect
                  value={manualTx.playerId}
                  onValueChange={(value) =>
                    setManualTx((current) => ({ ...current, playerId: value }))
                  }
                  options={activePlayers.map((player) => ({
                    value: player.id,
                    label: player.name,
                  }))}
                />
              </FormField>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Amount">
                <Input
                  value={manualTx.amount}
                  inputMode="decimal"
                  onChange={(event) =>
                    setManualTx((current) => ({
                      ...current,
                      amount: event.target.value,
                    }))
                  }
                  placeholder="Amount"
                />
              </FormField>
              <FormField label="Staff">
                <Input
                  value={manualTx.staff}
                  onChange={(event) =>
                    setManualTx((current) => ({
                      ...current,
                      staff: event.target.value,
                    }))
                  }
                  placeholder="Dealer / cashier"
                />
              </FormField>
            </div>
            <FormField label="Note">
              <Input
                value={manualTx.note}
                onChange={(event) =>
                  setManualTx((current) => ({ ...current, note: event.target.value }))
                }
                placeholder="Note"
              />
            </FormField>
            <Button className="w-full sm:w-auto" onClick={handleManualTransaction}>
              <Plus /> Request transaction approval
            </Button>
          </CardContent>
        </Card>
      </div>
      <Card className="rounded-lg">
        <CardHeader>
          <CardTitle>Transaction log</CardTitle>
          <CardDescription>
            Sample cashier ledger with cash handling fields
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {transactions.map((tx) => {
            const player = players.find((item) => item.id === tx.playerId);

            return (
              <div key={tx.id} className="rounded-lg border p-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="break-words font-medium">
                    {tx.type} | {money(tx.amount)}
                  </p>
                  <Badge
                    tone={
                      tx.type === "Cash-out"
                        ? "red"
                        : tx.type === "Buy-in"
                          ? "green"
                          : "blue"
                    }
                  >
                    {tx.time}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {player?.name || tx.tableId} | {tx.staff} | {tx.note}
                </p>
                <p className="text-xs text-muted-foreground">
                  Cash received {money(tx.cashReceived)} | Cash payout{" "}
                  {money(tx.cashPayout)}
                </p>
                <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
                  <Button
                    className="w-full sm:w-auto"
                    size="sm"
                    variant="outline"
                    onClick={() => window.print()}
                  >
                    Print receipt
                  </Button>
                  <Button
                    className="w-full sm:w-auto"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Request manager correction for ${tx.id}?`,
                        )
                      ) {
                        requestCorrection(tx.id);
                      }
                    }}
                  >
                    Request correction
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
