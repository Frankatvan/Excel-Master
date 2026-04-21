# Migrating Environment Variables to Vercel

To deploy your application to Vercel, you need to move your local environment variables from `.env.local` to the Vercel project settings. This keeps your secrets secure and makes them available to your deployed application.

## Steps:

1.  **Find your local variables:**
    Open the `.env.local` file in your project root. It will contain key-value pairs like this:
    ```
    GOOGLE_CLIENT_ID=...
    GOOGLE_CLIENT_SECRET=...
    NEXTAUTH_SECRET=...
    ```

2.  **Navigate to Vercel Project Settings:**
    - Go to your Vercel Dashboard.
    - Select the project linked to this repository.
    - Go to the **Settings** tab.
    - Click on **Environment Variables** in the left-hand menu.

3.  **Add Environment Variables:**
    - For each variable in your `.env.local` file, add a new environment variable in Vercel.
    - **Copy the key** (e.g., `GOOGLE_CLIENT_ID`) and **paste it into the "Name" field** in Vercel.
    - **Copy the value** and **paste it into the "Value" field**.
    - Choose the environments (Production, Preview, Development) where the variable should be available. For secrets, it's common to make them available in all environments.
    - Click **Save**.

4.  **Repeat for all variables:**
    Repeat the process for all variables in your `.env.local` file.

5.  **Security Note:**
    Your `.env.local` file is listed in `.gitignore` and should never be committed to your repository. By using Vercel's environment variables, you avoid exposing your secrets in your codebase.

Once you have moved all your variables to Vercel, your application will have secure access to them when deployed.
