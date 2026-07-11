# Vox - Voting Plugin for TREK

**Group decision making for TREK trips.** Vote on activities by location and let the group's collective wisdom guide your travel plans.

![Screenshot](screenshot.png) <!-- À ajouter quand tu auras une capture -->

## Features

- 📍 **Location-based organization** - Activities are grouped by trip location
- ⭐ **1-5 star voting system** - Each member can rate activities
- 📊 **Real-time metrics** - Consensus score and participation rate update instantly
- 👥 **Voter transparency** - See who has voted and their scores
- 🏆 **Automatic ranking** - Top activities rise to the top based on consensus
- 📱 **Mobile-first** - Works seamlessly on all devices

## Permissions

| Permission | Purpose |
|------------|---------|
| `db:own` | Store activities, votes, and plugin state |
| `db:read:trips` | Access trip structure and members for participation metrics |
| `db:read:users` | Link votes to users for transparency |
| `db:write:places` | Create the best-voted places in TREK |
| `http:outbound:nominatim.openstreetmap.org` | Geocode addresses for location data |

## Installation

No configuration required. The plugin activates immediately after installation.

1. Open TREK settings
2. Go to Plugins
3. Install Vox from the store, or install manually from the release

## License

MIT License

Copyright (c) 2024 Maxime Cn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.