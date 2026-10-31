# Home-manager module for Eshlik speech-to-text
#
# Provides a systemd user service for autostart.
# Usage: imports = [ elchi.homeManagerModules.default ];
#        services.elchi.enable = true;
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.elchi;
in
{
  options.services.elchi = {
    enable = lib.mkEnableOption "Eshlik speech-to-text user service";

    package = lib.mkOption {
      type = lib.types.package;
      defaultText = lib.literalExpression "elchi.packages.\${system}.elchi";
      description = "The Eshlik package to use.";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.user.services.elchi = {
      Unit = {
        Description = "Eshlik speech-to-text";
        After = [ "graphical-session.target" ];
        PartOf = [ "graphical-session.target" ];
      };
      Service = {
        ExecStart = "${cfg.package}/bin/elchi";
        Restart = "on-failure";
        RestartSec = 5;
      };
      Install.WantedBy = [ "graphical-session.target" ];
    };
  };
}
