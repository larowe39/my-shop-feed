# Welcome to your Expo app 👋

This is an [Expo](https://expo.dev) project created with [`create-expo-app`](https://www.npmjs.com/package/create-expo-app).

## Get started

1. Install dependencies

   ```bash
   npm install
   ```

2. Start the app

   ```bash
   npx expo start
   ```

In the output, you'll find options to open the app in a

- [development build](https://docs.expo.dev/develop/development-builds/introduction/)
- [Android emulator](https://docs.expo.dev/workflow/android-studio-emulator/)
- [iOS simulator](https://docs.expo.dev/workflow/ios-simulator/)
- [Expo Go](https://expo.dev/go), a limited sandbox for trying out app development with Expo

You can start developing by editing the files inside the **app** directory. This project uses [file-based routing](https://docs.expo.dev/router/introduction).

## Get a fresh project

When you're ready, run:

```bash
npm run reset-project
```

This command will move the starter code to the **app-example** directory and create a blank **app** directory where you can start developing.

## Demo social network seeder

`scripts/seed-social-demo.js` creates ~10 realistic demo seller accounts for
local development (follow/unfollow testing, FOR YOU seller diversity, etc.).

It requires a Supabase **service role** key (admin access), which must never
be used in client code or committed. Add it to a local, gitignored
`.env.local` file (see `.env.example`):

```
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
```

Commands:

```bash
npm run seed:social                                  # seed/update demo sellers
npm run seed:social -- --status                      # report demo data counts
npm run seed:social -- --clean                       # remove demo sellers/data only
npm run seed:social -- --follow-demo=you@example.com # optional: your account follows a few demo sellers
```

Demo accounts sign in with `demo.<name>@penchant.local` and a shared
dev-only password (`Penchant-Demo-2026!` by default, overridable via
`DEMO_SELLER_PASSWORD`).

## AI Image Moderation (Sightengine)

PENCHANT uses automated AI image moderation powered by [Sightengine](https://sightengine.com/) via the `moderate-product-image` Supabase Edge Function.

### Features & Architecture
- **Instant Publishing**: Product uploads complete and publish immediately with a `pending` moderation state.
- **Asynchronous Moderation**: The Edge Function evaluates images in the background and sets status to `approved`, `blurred`, `hidden`, or `failed`.
- **Fail-Open Policy**: If Sightengine is unavailable, times out, or errors, the product defaults to `failed` status and remains visible.
- **Conservative Thresholds**: Sensitive material (weapons, erotica, suggestive imagery) triggers a sensitive content blur overlay rather than auto-hiding. High-confidence severe content (explicit sexual activity, graphic gore, severe violence, hate symbols, self-harm) is automatically hidden.
- **Dependency-Free**: The Edge Function uses native `fetch()` with no external bundling dependencies.

### Supabase Edge Function Secrets
Set the following secrets in your Supabase project (never expose in client code):

```bash
supabase secrets set SIGHTENGINE_API_USER="your-sightengine-api-user"
supabase secrets set SIGHTENGINE_API_SECRET="your-sightengine-api-secret"
```

To enable development bypass mode (allowing `devOutcome` testing in development):
```bash
supabase secrets set MODERATION_DEV_MODE="true"
```

## Learn more

To learn more about developing your project with Expo, look at the following resources:

- [Expo documentation](https://docs.expo.dev/): Learn fundamentals, or go into advanced topics with our [guides](https://docs.expo.dev/guides).
- [Learn Expo tutorial](https://docs.expo.dev/tutorial/introduction/): Follow a step-by-step tutorial where you'll create a project that runs on Android, iOS, and the web.

## Join the community

Join our community of developers creating universal apps.

- [Expo on GitHub](https://github.com/expo/expo): View our open source platform and contribute.
- [Discord community](https://chat.expo.dev): Chat with Expo users and ask questions.
