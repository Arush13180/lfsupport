# lfsupport

Complaint ticket booking for LeadFinder support.

- `/` — customers enter name, mobile and complaint, choose today or a later date and a free 30-minute slot (10:00 AM – 06:00 PM IST), and get a ticket ID.
- `/admin` — password-protected panel to see complaints and mark them solved. Solving a ticket frees its slot.

A booked slot is hidden from everyone until that ticket is solved (enforced by a unique database index, so two people can't grab the same slot).

## Environment variables
- `DATABASE_URL` — Postgres connection string (e.g. Neon)
- `ADMIN_PASSWORD` — password for /admin
- Optional: `BOOKING_DAYS_AHEAD` (default 30), `MAX_OPEN_PER_PHONE` (default 1)

## Run
```
npm install
npm start
```
