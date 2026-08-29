import opentimelineio as otio

# 1. Read the existing OTIO file
timeline = otio.adapters.read_from_file("output.otio")

# 2. Safely find the clip you want to modify
# In OTIO, you can iterate over a track directly or use find_clips()
for track in timeline.tracks:
    if track.kind == otio.schema.TrackKind.Video:
        # Loop directly through the elements in the track
        for clip in track:
            # Verify the item is actually a Clip object (tracks can also hold Gaps/Transitions)
            if isinstance(clip, otio.schema.Clip) and clip.name == "Video Clip":

                # 3. Make your changes
                clip.name = "Updated Video Clip Name"

                # Offset start time to frame 48 at 24fps
                new_start = otio.opentime.RationalTime(48, 24)
                new_duration = clip.source_range.duration # keep existing duration

                clip.source_range = otio.opentime.TimeRange(
                    start_time=new_start,
                    duration=new_duration
                )

                print(f"Successfully modified clip properties!")

# 4. Write the modifications back to a new file
otio.adapters.write_to_file(timeline, "output_modified.otio")
print("Saved modifications to 'output_modified.otio'")
