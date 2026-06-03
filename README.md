# Gemini-live-chat-

Departure Bucket =
SWITCH(
    TRUE(),
    flights[SCHEDULED_DEPARTURE] < 600, "Early Morning",
    flights[SCHEDULED_DEPARTURE] < 1200, "Morning",
    flights[SCHEDULED_DEPARTURE] < 1700, "Afternoon",
    flights[SCHEDULED_DEPARTURE] < 2100, "Evening",
    "Night"
)
