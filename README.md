# ReadyMed Visit Portal (HomeStar pilot demo)

A static web demo of the ReadyMed x HomeStar visit portal. One page, two buttons:

- **Family Room** (`family.html`): request a visit, quick check-in, take biometrics (experimental), see alerts.
- **Clinician Room** (`clinician.html`): patient list, request a visit, remote check-in, send a reminder, take biometrics (experimental), alerts, Medicare RPM minutes, call log.

Live page: `https://homestarhub.github.io/readymed-portal/`

## What is real and what is simulated

| Real | Simulated |
| --- | --- |
| "Request a visit" rings the HomeStar device (through a free ntfy.sh channel) and opens the video room | Patients, alerts, check-ins, reminders |
| An incoming call from the device shows a Join button | Biometrics readings (experimental) |
| | Medicare minutes, OmniMD link |

Every simulated item is labeled in the page.

## Demo controls (bottom-right button)

- **Device channel name** and **video room link**: type them in on the demo computer. They are stored in that browser only. They are not in this repo.
- **Simulate an event**: fall, called for help, no answer, left the bed, no movement, device offline / back online, patient calls, biometrics reading, reset.
- **Fast clock**: 1 second counts as 1 minute, so the 20-minute mark can be shown in seconds.

## Notes

- Family and Clinician pages share their data only inside the same browser. Across devices, only the device ring and incoming calls (through ntfy) work. A real backend (Flask API) replaces this later.
- No patient data. No secrets. Keep it that way: this repo is public.
- The video room is a free Jitsi Meet room for the demo. It is not HIPAA-appropriate.
- No build step. Plain HTML, CSS and JavaScript. To update, upload changed files to this repo.
