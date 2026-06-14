# The Book

A quick bet-settlement calculator. Each bet line is saved to **Supabase**; the app
deploys to **Vercel**. Built with Vite + React.

Settlement rules (typed amount is multiplied by 100):
- **Win** → collect the full bet
- **½ Win** → collect half
- **½ Lose** → pay 45% (half of 90%)
- **Lose** → pay 90%

## Run locally

```bash
npm install
npm run dev
```

Without Supabase keys the app still works — it stores bets in your browser's
`localStorage`. Add the keys below to switch to the shared Supabase database.

## 1. Set up Supabase (a NEW, dedicated project)

1. Create a brand-new project at https://supabase.com (don't reuse another app's project).
2. Open **SQL Editor → New query**, paste the contents of [`supabase/schema.sql`](supabase/schema.sql), and **Run**. This creates the `bets` table.
3. Go to **Project Settings → API** and copy:
   - **Project URL**
   - **anon public** key
4. Put them in `.env.local` (copy from `.env.example`):

   ```
   VITE_SUPABASE_URL=https://your-project-ref.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-public-key
   ```

5. Restart `npm run dev`. Bets now read/write Supabase.

> Note: the app uses the public anon key from the browser and has no login, so the
> `bets` table is open to anyone with the URL (fine for a private tool). To lock it
> down later, add Supabase Auth and scope rows to `auth.uid()`.

## 2. Deploy to Vercel

**Option A — Vercel CLI (fastest):**

```bash
npm i -g vercel
vercel            # first run: log in + link the project
vercel --prod     # production deploy
```

**Option B — GitHub + Vercel dashboard:**

1. Push this folder to a GitHub repo.
2. In Vercel, **Add New → Project**, import the repo. It auto-detects Vite.
3. Deploy.

**Either way**, add the two env vars in Vercel so production talks to Supabase:
**Project → Settings → Environment Variables** →
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` → redeploy.
