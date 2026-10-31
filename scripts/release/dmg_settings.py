# dmgbuild settings for Eshlik's DMG window: the branded background
# (scripts/brand/dmg_background.html, rendered to dmg/background.tiff), Eshlik on the
# left and Applications on the right where the artwork stages them, no toolbar or
# sidebar, and the app icon as the volume's icon.
#
#   dmgbuild -s scripts/release/dmg_settings.py -D app=<path to Eshlik.app> \
#     -D background=scripts/release/dmg/background.tiff Eshlik out.dmg
#
# dmgbuild runs this file with exec and no __file__, so paths come in as -D values.
import os.path

app = defines["app"]  # noqa: F821  (dmgbuild passes -D values in as `defines`)
app_name = os.path.basename(app)

format = "UDZO"
filesystem = "HFS+"
size = None
files = [app]
symlinks = {"Applications": "/Applications"}
badge_icon = None
icon = os.path.join(app, "Contents/Resources/icon.icns")

background = defines["background"]  # noqa: F821
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
sidebar_width = 0
# The window's content is the artwork's 660x420; the frame adds Finder's title bar.
window_rect = ((240, 160), (660, 448))
default_view = "icon-view"
show_icon_preview = False
include_icon_view_settings = True
arrange_by = None
grid_offset = (0, 0)
grid_spacing = 100
scroll_position = (0, 0)
label_pos = "bottom"
text_size = 13
icon_size = 112
icon_locations = {
    app_name: (165, 200),
    "Applications": (495, 200),
    # The volume's own files, shown by Finders set to show hidden files: parked
    # outside the window, where they cannot sit on the artwork.
    ".background.tiff": (165, 900),
    ".VolumeIcon.icns": (495, 900),
    ".fseventsd": (330, 900),
}
hide_extension = [app_name]
