# Manual check — Phase 2b (PIDs, import, route builder, assignments)

Run this in a real browser. Each step lists the **expected result**. Tick ✅ or note what you saw.
Data created here stays in the database (that is intended).

Sample file: `workflow-docs/samples/pids-sample.csv`: 31 rows in zone **NIT**, ward **12**, around the default
map centre (28.4082, 77.3178). It contains deliberate errors and warnings.

---

## 0. Start

1. Terminal 1: `cd be` → `npm run dev`. **Expect:** `API server listening` (port 5000).
2. Terminal 2: `cd fe` → `npm run dev`. **Expect:** `Local: http://localhost:5173/`.
3. Open http://localhost:5173/login and sign in as `admin@gpspid.local`.
   **Expect:** the Home page. The sidebar shows **Operations** (PIDs, PID Import, Routes, Assignments), **Master Data** and **Administration**.

## 1. Sample master data (one-time)

4. **Zones → Add zone:** code `NIT`, name `NIT Faridabad` → Create. **Expect:** toast "Zone created", and the row shows code `NIT`.
5. **Wards → Add ward:** zone `NIT`, ward number `12`, name `Ward 12` → Create. **Expect:** the row shows zone NIT.
6. **Agencies → Add agency:** `ABC Agency` → Create.
7. **Vehicles → Add vehicle:** number `HR38AB1234`, type `Tipper`, agency ABC Agency, zone NIT, ward 12 → Create.
8. Add a second vehicle: `HR38AB5678`, `Tipper`, ABC Agency, NIT / 12.

## 2. PID import (sample CSV)

9. **PID Import →** click **Template (CSV)** and **Template (XLSX)**. **Expect:** two files download, each with just the header row.
10. Drag `workflow-docs/samples/pids-sample.csv` onto the drop area, or click it and pick the file. **Expect:** the file name and size appear.
11. Try picking a `.txt` or `.pdf` file. **Expect:** red "Only .csv and .xlsx files are accepted". Then re-pick the sample CSV.
12. Leave **Skip it** selected → **Validate file**. **Expect:** an upload progress bar, then the summary cards:
    **Total 31 · Valid 26 · Errors 5 · Warnings 5 · Duplicates in file 2 · Already in DB 0**.
13. Findings table: **10 rows**:
    - row 6 and row 32: `DEMO005 appears 2 times`
    - row 29: `PID number is required`
    - row 30: `Ward 99 does not exist in zone NIT`
    - row 31: `Provide both latitude and longitude`
    - rows 24–25: `Missing coordinates`
    - row 26: `look swapped`
    - rows 27–28: `Same coordinates as …`
14. Set **Show → Warnings**. **Expect:** only the 5 warning rows.
15. **Download full report (CSV)**. **Expect:** `pid-import-report.csv` with the same 10 findings.
16. Click **Import 26 valid rows** → confirm **Import**. **Expect:** "Import complete", **Inserted 26**, Updated 0, Skipped 0.
17. Optional: validate the same file again. **Expect:** **Already in DB 26**; importing again with Skip inserts 0.

## 3. PIDs page, map view, fixing coordinates

18. **PIDs.** **Expect:** 26 rows (DEMO001…DEMO027, without DEMO005), and an amber chip **Missing coordinates (2)**.
19. Click the chip. **Expect:** only DEMO023 and DEMO024. Click it again to clear the filter.
20. Click **Map** (top right). **Expect:**
    - Blue dots clustered around Faridabad Sector 7 (~23 dots), the OSM map with its attribution, and a legend.
    - DEMO025 is **not** among them: its coordinates are swapped, so it plots near the Arctic.
21. Zoom in and out and pan quickly. **Expect:** smooth movement, and dots reload without the page freezing.
22. Click a dot. **Expect:** a popup with the PID number, status and coordinates, plus a **Fix location** button.
23. Back to **Table**. Filter **Has coordinates → Missing**, then on **DEMO023** click **Fix location**.
    **Expect:** a map at the default centre with the text "This PID has no coordinates yet", and **Save location** disabled.
24. Click a spot on the map. **Expect:** a marker appears and the lat/lng inputs fill in. Drag the marker. **Expect:** the inputs update.
25. **Save location.** **Expect:** toast "Location of DEMO023 updated", the coordinates column shows **Manually corrected** (teal), and the chip reads **(1)**.
26. On **DEMO025**, click **Fix location**. **Expect:** the inputs show `77.3191` / `28.4101`.
27. Click **Save location** without changing anything. **Expect:** an amber notice "Latitude/longitude look swapped…" with **Save anyway** / **Cancel**, and **nothing is saved yet**.
28. Click **Cancel**, change the inputs to latitude `28.4101` and longitude `77.3191`, tick **Mark as verified**, then **Save location**.
    **Expect:** it saves directly, with no warning, and the status is **Verified** (green).

## 4. Route builder

29. **Routes → Add route.** **Expect:** a two-panel page with the form on the left and an empty map with "Choose a ward…" on the right.
30. Fill in: code `route001`, name `Sector 7 Loop`, zone NIT, ward **12**, agency ABC Agency.
    The **Default vehicle** list should only show the ABC vehicles; pick `HR38AB1234`.
    **Expect:** the map fits to ~25 grey dots (the ward's PIDs).
31. With **Select PIDs** on, click 3 grey dots. **Expect:** they turn purple, and "Route PIDs: 3 selected" lists them.
32. **Hold Shift and drag** a rectangle around a group of dots. **Expect:** a dashed purple box while you drag, and every dot inside becomes selected (the count goes up). The map must **not** zoom.
33. In the list below, click **Remove** on one PID. **Expect:** the count drops by 1 and that dot turns grey.
34. **Set start** → click the map. **Expect:** a green "Start" marker. **Set end** → click elsewhere. **Expect:** a red "End" marker.
35. **Draw line** → click 4 points. **Expect:** a purple line. Click **Undo point** once. **Expect:** 3 points.
36. Click the sidebar **Home** link before saving. **Expect:** a browser confirm "You have unsaved changes…". Click **Cancel** to stay.
37. **Create route.** **Expect:** toast "Route ROUTE001 saved with N PIDs" (code uppercased), the URL becomes `/routes/<id>`, and "Unsaved changes" disappears.
38. Reload the page (F5). **Expect:** the same selection, start/end, line, and the vehicle are restored.
39. **Routes** list. **Expect:** ROUTE001 shows ward 12, agency ABC, default vehicle HR38AB1234, and PIDs = N.

## 5. Daily assignments

40. **Assignments.** **Expect:** today's date (IST) is preselected, and an empty-state message.
41. **Create assignment:** route `ROUTE001`, vehicle `HR38AB1234`, no shift times → Create.
    **Expect:** a row with Shift "All day", PIDs = N, Coverage `0/N confirmed` with a red bar, status **Planned**.
42. Create the same route and vehicle again. **Expect:** a red toast "An assignment for this route, vehicle and date already exists".
43. Create route `ROUTE001`, vehicle `HR38AB5678`, shift start `20:00`, end `04:00`.
    **Expect:** the hint "Ends the next day (crosses midnight)" before saving, and then the row shows Shift **20:00–04:00 (+1)**.
44. Click **View** on the first row. **Expect:**
    - A side drawer with the date, route, vehicle and coverage.
    - A small map of the N snapshot PIDs (red = not visited).
    - The PID list, all "Not visited". Filter Status → Not visited and check the count still matches.
45. **Copy from another day:** from **today**, to **tomorrow** → Copy.
    **Expect:** a result table with **2 created**. Change the page date to tomorrow. **Expect:** 2 Planned rows, and the night shift still reads 20:00–04:00 (+1).
46. Run the copy again (today → tomorrow). **Expect:** 0 created, **2 already existed** ("skipped duplicate").
47. Snapshot immutability: open **Routes → ROUTE001**, remove 2 PIDs, Save. Back on **Assignments** (today), **View** the HR38AB1234 row.
    **Expect:** it still lists **N** PIDs. The snapshot is frozen.
48. On tomorrow's HR38AB1234 row, click **Re-snapshot** → confirm. **Expect:** toast "PID snapshot refreshed…" and the PIDs count becomes **N − 2**.
49. **Cancel** tomorrow's HR38AB5678 row → confirm. **Expect:** status **Cancelled** (struck through), and the Cancel / Re-snapshot buttons disappear for that row.

## 6. Agency user view (permissions)

50. **Users → Add user:** role Agency User, agency ABC Agency, email `abc.user@test.local`, password `Passw0rd1` → Create. Log out and sign in as that user.
51. **Expect:**
    - The sidebar shows Home, **PIDs, Routes, Assignments**, Zones, Wards, Agencies, Vehicles.
    - No **PID Import** and no **Users**.
52. **PIDs:** only the PIDs on ROUTE001 (or in ABC's assignments); no Add / Edit / Fix location buttons. **Routes → ROUTE001:** the form is greyed out, with no Save button and no map tools.
    **Assignments:** rows visible; no Create, Copy, Cancel or Re-snapshot buttons, but **View** works.

---

### Report back
Note any step whose result differed from **Expect**, with the step number and a screenshot if possible.
Especially note step 21 (map smoothness), step 32 (Shift-drag selection) and step 36 (unsaved-changes prompt).
