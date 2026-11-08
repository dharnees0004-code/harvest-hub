# HarvestHub Project Conventions & Workflow Rules

## Application Flow
1. **Splash Screen (`SplashScreen.tsx`)**:
   - Initial branded splash screen.
   - Clean presentation with interactive logo click.
   - Smoothly transitions into the Location Detection Screen upon clicking the logo or splash completion.

2. **Location Detection Screen (`LocationDetectionScreen.tsx`)**:
   - High-precision GPS and Google Maps Platform integration.
   - Dedicated "Find Fresh Products Near You" screen immediately after the splash animation.
   - Interactive map with draggable location marker, "Locate Me" floating control, real-time reverse geocoding, accuracy indicator, and permission states (prompting, granted, denied, unavailable).
   - "Use Current Location" and "Confirm Location" actions with smooth confirmation transition.

3. **Welcome & Store Screen (`WelcomeScreen.tsx` & `CinematicMainScreen.tsx`)**:
   - Direct store experience with fresh category selection (Fresh Fruits, Farm Veggies, Pure Dairy).
   - Nearest warehouse routing calculated dynamically from the confirmed delivery location.
   - Dedicated Fresh Fruits market experience and categorized store catalog.
   - Option to replay the splash screen or adjust location at any time.

4. **Login Screen (`LoginScreen.tsx`)**:
   - Features HarvestHub logo, Email/Mobile & Password inputs, Remember Me, Sign In, and "Continue as Guest Customer" options.

## Key Design Principles
- Modern dark luxury theme (`slate-950` canvas with `emerald` & `teal` high-contrast accents).
- High performance React 18 + Vite + Tailwind CSS + Framer Motion.
