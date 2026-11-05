# Manual check: Phase 5 (monitoring: dashboard, live map, coverage map, history, admin)

Run this in a real browser. Each step lists the **expected result**; tick ✅ or note what you saw.

This demo writes **simulator** GPS data into your database. Step 9 deletes it again.

Wording to look for everywhere: **"GPS confirmed"** and **"GPS visit detected"**, never "collected".

---

## 0. Prerequisites: sample data

You need, **for today (IST)**:
- at least one zone and ward with PIDs that have coordinates;
- a route on those PIDs;
- **two vehicles that have a GPS device ID**;
- assignments of that route to both vehicles.

**Already did the Phase 2b checklist?** Then the data is there: zone **NIT**, ward **12**, `ABC Agency`, vehicles `HR38AB1234` / `HR38AB5678`, route `ROUTE001`.
- Open **Vehicles → Edit** on both vehicles and set a **GPS device ID** if it is empty (e.g. `SIM-1234`, `SIM-5678`). The simulator only moves vehicles that have one.
- Open **Assignments**. The date defaults to today. If today has no rows, create `ROUTE001 → HR38AB1234` (no shift) and `ROUTE001 → HR38AB5678` (no shift).

**Starting fresh?** Recreate the data from `workflow-docs/samples/pids-sample.csv`:
- follow `manual-check-phase2b.md` §1 (zone, ward, agency, 2 vehicles, with GPS device IDs);
- §2 (import the CSV, commit);
- §4 (route `ROUTE001` with ~10 PIDs);
- §5 steps 40–41 (today's assignments).

Also create one **agency user** for step 8: **Users → Add user**, role Agency User, agency ABC Agency.

## 1. Start the backend with the simulator (PowerShell, Windows)

Terminal 1:

```powershell
cd be
$env:GPS_PROVIDER = 'simulator'
$env:GPS_POLL_ENABLED = 'true'          # also starts the detection worker
$env:GPS_POLL_INTERVAL_SECONDS = '15'   # faster demo (default 60)
$env:GPS_SIM_SPEED_KMH = '12'
$env:GPS_SIM_JITTER_M = '8'
$env:GPS_SIM_OFFLINE_VEHICLES = ''      # e.g. 'HR38AB5678' to see an OFFLINE vehicle
npm run dev
```

**Expect:** `API server listening` on port 5000, then GPS poll log lines every ~15 s.

These variables last for this terminal window only, and they override `be/.env`. To stop, press Ctrl+C. To undo, close the window, or run `Remove-Item Env:GPS_POLL_ENABLED`.

Terminal 2:

```powershell
cd fe
npm run dev
```

**Expect:** `Local: http://localhost:5173/`.

## 2. Login, header and sidebar

1. Open http://localhost:5173/login and sign in as `admin@gpspid.local`.
   - **Expect:** the **Dashboard** opens (not the welcome page).
   - **Expect** in the header: a green **Live** pill (real-time connected) and a **GPS up** badge, which turns green after the first poll.
   - **Expect** in the sidebar: **Monitoring** (Dashboard, Live Tracking, Coverage Map, GPS History), Operations, Master Data, and **Administration** (Users, Detection Settings, GPS Integration, Activity Logs).
2. Stop the backend for ~10 s (Ctrl+C in terminal 1), then start it again.
   - **Expect:** the pill goes amber **Reconnecting…**, then back to green **Live**.
   - **Expect:** the page refreshes its data by itself.

## 3. Live Vehicle Tracking: the map moves

3. Open **Live Tracking**.
   - **Expect:** the map fits your vehicles.
   - **Expect:** markers are green (**Online**), and the legend at the bottom left shows a count per status.
   - **Expect:** "last update x s ago" in the subtitle, ticking.
4. Wait 30–60 s. **Expect:** markers move along the route, with no page reload.
5. Zoom in to street level (zoom ≥ 15). **Expect:** each marker shows its vehicle number as a label.
6. Type `HR38AB1234` (or part of it) in **Find vehicle** → **Go**.
   - **Expect:** the map flies to the vehicle and the side panel opens with: number, agency, route, lat/lng, speed, ignition, "Last updated x s ago" (ticking), today's visit events, assigned / GPS confirmed / candidate / remaining.
7. In the panel, click **Open coverage map**. **Expect:** the Coverage Map opens on today's assignment for that vehicle.
8. *(Optional)* Restart the backend with `$env:GPS_SIM_OFFLINE_VEHICLES = 'HR38AB5678'`. After ~5 min (`gps.offline_after_seconds`), that marker turns **Offline** (red-grey) by itself, without a server push.

## 4. Coverage map: recolours over time

9. On **Coverage Map** (date = today, your assignment selected):
   - **Expect:** PIDs coloured by status; the **purple** assigned route (if the route has geometry); the **orange** actual GPS trail; the **blue** current vehicle marker.
   - **Expect:** a legend explaining every colour, plus the disclaimer.
10. Keep the page open for a few minutes.
    - **Expect:** PIDs near the trail change from **Not visited** (red-orange ring) to **Candidate** (amber) or **Confirmed** (green), without a reload.
    - **Expect:** the comparison panel counts change, and the trail grows.
11. Untick **All PIDs**, then **Unvisited**. **Expect:** only confirmed and candidate PIDs remain. Tick both again.
12. Untick **Assigned route** or **Actual route**. **Expect:** that line disappears.
13. Click a green or amber PID.
    - **Expect:** a drawer with PID number, address, ward, zone, route, vehicle, status, first and last GPS visit, minimum distance.
    - **Expect:** an **evidence list** with times and distances, and labels **"GPS point within X m"** and/or **"Track passed nearby (between two GPS points)"**.
    - **Expect:** an **Ambiguous** badge where a GPS point was within the radius of 2+ PIDs.
14. Find a PID whose evidence shows **both** a point item and a track-segment item (common on straight stretches at 15 s polling). Note its PID number: ________
15. Comparison panel:
    - **Expect:** GPS route distance with a **Reliable** badge (or **Not reliable** plus reasons, e.g. a gap > 10 min).
    - If the route has geometry, **expect** a % off route, the max deviation and the off-route segments. Clicking a segment zooms to it, drawn red dashed.

## 5. Dashboard: numbers rise

16. Open **Dashboard** (date = today).
    - **Expect:** the large **GPS Confirmed Coverage %** headline; next to it **GPS Visit Detected %**, and the confirmed / candidate / remaining / no-GPS-visit counts.
    - **Expect:** vehicle and PID cards (total, **Active (GPS on date)**, **Online now**, offline, registered PIDs, assigned).
17. Wait 1–2 min with the page open. **Expect:** the numbers update by themselves, about 5 s after detections.
18. Charts:
    - **Expect:** zone- and ward-wise stacked bars with a % label, agency bars and table, and the 14-day trend (two lines).
    - **Expect:** the vehicle performance table: click headers to sort; try **Worst 10** / **Best 10**.
    - **Expect:** hourly activity with GPS points and visit events.
    - **Expect:** the disclaimer footnote at the bottom.
19. Change **Zone** / **Agency**. **Expect:** the URL updates (`?zone_id=…`), and reloading the page keeps the filters.

## 6. History playback

20. Open **GPS History**. Pick vehicle `HR38AB1234`, date today, 00:00–23:59 → **Show track**.
    - **Expect:** an orange polyline with a green start and a black end marker.
    - If the day has more than 5,000 points, **expect** "Downsampled: showing N of M points".
21. **Play** at **60×**. **Expect:** the blue marker moves along the track in time order (it pauses where the vehicle was standing), and the timestamp and speed update.
22. **Pause**, then drag the slider. **Expect:** the marker jumps to that time. Try **1×**, **5×**, **20×**.
23. Tick **Show PIDs of that day's assignment(s)**. **Expect:** PIDs coloured by status.

## 7. Settings: change the radius, reprocess, see the difference

24. Note the dashboard **GPS Visit Detected %** and the coverage-map counts for today: ________
25. **Detection Settings:**
    - **Expect:** groups (Proximity, Confirmation, Quality gates, Segment evidence, Finalization, Comparison), each field showing its range, the "applies to new processing only" notice, and the read-only **Recommended field-trial starting point** box.
26. Type `500` for **radius_m** → **Save**. **Expect:** "Must be at most 200", and nothing is saved.
27. Set **radius_m** to `10` → **Save**. **Expect:** toast "radius_m saved. Applies to new processing only."
28. **Reprocess:** scope **By date**, today → **Reprocess…**.
    - **Expect:** a confirmation that explains derived visit data is rebuilt and **raw GPS is kept**. Confirm.
    - **Expect:** the result is shown.
29. Wait ~1 min. **Expect:** the dashboard **detected %** and the coverage map counts are **lower** than in step 24 (a smaller radius means fewer PIDs within reach).
30. Set **radius_m** back to `30`, reprocess today again, and check the numbers recover.
31. **GPS Integration:**
    - **Expect:** read-only config (provider `simulator`, polling enabled, interval 15, …) and the sentence "Provider credentials are configured on the server and never shown here".
    - **Expect:** provider status and a recent-runs table; **Details** expands a rejected breakdown when there is one.
32. Click **Poll now** twice quickly. **Expect:** the first works; the second shows "Poll-now is limited to once every 30 seconds…".
33. **Activity Logs:** filter **Module** = `settings`.
    - **Expect:** your radius changes, with **Details** showing `old` / `new`.
    - **Expect:** no passwords, hashes or tokens in any details.

## 8. Scoped data: agency user

34. Log out, then log in as the agency user from step 0.
    - **Expect:** the sidebar's **Monitoring** section (Dashboard, Live Tracking, Coverage Map, GPS History) is present; there is **no** Detection Settings or Activity Logs.
    - Opening `/settings/detection` directly shows "Access denied".
35. **Live Tracking.** **Expect:** only ABC Agency's vehicles. **Dashboard:** numbers cover only ABC Agency's assignments.
36. *(If you have a second agency with its own vehicle and assignment)* **Expect:** its vehicles never appear on the map, even while moving.

## 9. Clean up: purge the simulator data

37. Stop the backend (Ctrl+C in terminal 1). In a **new** PowerShell window (so the demo env variables are gone):

```powershell
cd be
npm run gps:purge-sim                 # dry run: shows what would be deleted
npm run gps:purge-sim -- --confirm    # deletes simulator GPS points, latest locations, poll runs and their visit events
npm run gps:purge-sim                 # run the dry run again
```

**Expect:** the last dry run prints **0** for `pid_visit_events`, `vehicle_latest_locations`, `gps_locations` and `gps_poll_runs`.

38. *(Optional)* PID daily statuses are left as they were. To reset today's statuses to Not visited, start the backend normally and run **Detection Settings → Reprocess** for today. There is no GPS left, so everything becomes Not visited.
39. Log in as admin. **Expect:**
    - **Live Tracking** shows the vehicles as **No data**;
    - **GPS Integration** shows "No poll runs yet";
    - the header badge is grey, "GPS not polled yet".
