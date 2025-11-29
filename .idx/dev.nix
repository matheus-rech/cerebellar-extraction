{ pkgs, ... }: {
  channel = "stable-24.05";

  packages = [
    pkgs.nodejs_20
    pkgs.python311
    pkgs.python311Packages.pip
  ];

  idx.extensions = [
    "firebase.firebase-vscode"
  ];

  idx.workspace.onCreate = {
    npm-install = "npm install";
    functions-install = "cd functions && npm install";
    python-deps = "cd functions-python && pip install -r requirements.txt";
  };

  idx.workspace.onStart = {
    firebase-use = "firebase use cerebellar-extraction";
  };

  idx.previews = {
    enable = true;
    previews = {
      web = {
        command = ["python3" "-m" "http.server" "3000" "--directory" "public"];
        manager = "web";
        env = {
          PORT = "3000";
        };
      };
    };
  };
}
