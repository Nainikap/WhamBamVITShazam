import opentimelineio as otio

# Create a new timeline
timeline = otio.schema.Timeline(name="My MP4 Timeline")

# Create a track
track = otio.schema.Track(name="Video Track", kind=otio.schema.TrackKind.Video)

# Create a media reference pointing to your MP4 file path or URL
media_ref = otio.schema.ExternalReference(target_url="C:/Users/naini/Videos/Captures.Shadow CLone - Google Chrome 2026-05-03 23-10-55.mp4")

# Create a clip referencing the media (set duration as needed, e.g., 240 frames at 24fps)
clip = otio.schema.Clip(
    name="Video Clip",
    media_reference=media_ref,
    source_range=otio.opentime.TimeRange(
        start_time=otio.opentime.RationalTime(0, 24),
        duration=otio.opentime.RationalTime(240, 24)
    )
)

# Add clip to track, track to timeline
track.append(clip)
timeline.tracks.append(track)

# Write out to an .otio file
otio.adapters.write_to_file(timeline, "output.otio")
