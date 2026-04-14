# SON-97 alerting-oppsett

Hvis `PUSHOVER_TOKEN` og `PUSHOVER_USER` finnes i Paperclip-containerens miljø, sendes kritiske varsler dit.

Hvis Pushover ikke er konfigurert:

- `PAPERCLIP_ALERT_WEBHOOK_URL` kan settes til en valgfri mock/webhook-endpoint som mottar JSON `POST`.
- Hvis heller ikke webhook er satt, skriver Paperclip fallback-varsler til `report/mock-alerts.ndjson` under `PAPERCLIP_HOME`.

Miljøvariabler:

- `PUSHOVER_TOKEN`: applikasjonstoken fra Pushover.
- `PUSHOVER_USER`: Tores bruker-/gruppekey i Pushover.
- `PAPERCLIP_ALERT_WEBHOOK_URL`: valgfri mock-endpoint/webhook for testing.
- `PAPERCLIP_ALERT_MOCK_FILE`: valgfri override for lokal mock-fil.
- `PAPERCLIP_DRY_RUN_LOG_PATH`: absolutt sti til Kundeoversikt sitt `dry_run_log` som skal overvåkes.

Drift:

- Kritisk alert trigges når en agent feiler 4 ganger på rad.
- Kritisk alert trigges når scheduler-gap mellom heartbeat-ticks er større enn 5 minutter.
- Kritisk alert trigges når `dry_run_log` ikke vokser på over 5 minutter mens minst én run er `queued` eller `running`.

For ekte mobilvarsling må Tore opprette Pushover-konto og sette `PUSHOVER_TOKEN` + `PUSHOVER_USER` i Paperclip-containeren før restart.
