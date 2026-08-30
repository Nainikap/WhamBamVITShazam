export const KDENLIVE_NATIVE_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<mlt producer="main_bin" root="/edit/project">
  <profile frame_rate_num="25" frame_rate_den="1" width="1920" height="1080"/>
  <chain id="video-source">
    <property name="resource">media/shot.mp4</property>
    <property name="length">250</property>
    <property name="kdenlive:id">7</property>
    <property name="kdenlive:control_uuid">{11111111-1111-4111-8111-111111111111}</property>
    <property name="kdenlive:markers">[{"pos":15,"comment":"Take two","type":2,"duration":3}]</property>
  </chain>
  <chain id="audio-source">
    <property name="resource">/edit/project/voice.wav</property>
    <property name="length">100</property>
    <property name="kdenlive:id">8</property>
  </chain>
  <playlist id="audio-playlist">
    <blank length="00:00:00.400"/>
    <entry producer="audio-source" in="5" out="29"/>
  </playlist>
  <tractor id="audio-track">
    <property name="kdenlive:audio_track">1</property>
    <property name="kdenlive:track_name">Voice</property>
    <track hide="video" producer="audio-playlist"/>
  </tractor>
  <playlist id="video-playlist">
    <blank length="00:00:01.000"/>
    <entry producer="video-source" in="10" out="59"/>
  </playlist>
  <tractor id="video-track">
    <property name="kdenlive:track_name">V1</property>
    <track hide="audio" producer="video-playlist"/>
  </tractor>
  <tractor id="22222222-2222-4222-8222-222222222222">
    <property name="kdenlive:uuid">{22222222-2222-4222-8222-222222222222}</property>
    <property name="kdenlive:clipname">Main sequence</property>
    <property name="kdenlive:sequenceproperties.guides">[{"pos":30,"comment":"Review","type":1,"duration":0}]</property>
    <track producer="black"/>
    <track producer="audio-track"/>
    <track producer="video-track"/>
  </tractor>
  <playlist id="main_bin">
    <property name="kdenlive:docproperties.activetimeline">22222222-2222-4222-8222-222222222222</property>
    <property name="kdenlive:docproperties.version">1.1</property>
    <property name="kdenlive:docproperties.kdenliveversion">26.04.3</property>
  </playlist>
</mlt>`;
