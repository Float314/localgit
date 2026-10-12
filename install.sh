#!/usr/bin/env bash
# installation script for the project

echo "localgit installation from scratch."

echo "Welcome to localgit installation script"
echo "This script will install localgit on your system"
echo "Please make sure that you are running this script with sudo privileges" 

# check if we are running in sudo 
if [ "$EUID" -ne 0 ]; then 
  echo "The build script must be run as root/sudo. Please run the script with sudo."
  echo " Command to run: sudo ./install.sh"
  exit 1
fi

# list of dependencies to install 
dependencies=("git" "curl" "cgit" "nginx" "nodejs" "npm" "python3" "python3-pip" "python3-venv")
# To do : update this list as per time

# update the package list and install dependencies
echo "Running apt update..." 
sudo apt update

echo "Installing dependencies..."
sudo apt install -y "${dependencies[@]}"

echo "All dependencies are installed successfully.. "

echo "cloning localgit repository from github... "

git clone https://github.com/Float314/localgit.git localgit_tmp # temporary folder to clone the repo
cd localgit_tmp
npm install # install nodejs dependencies

# npm install this project
npm install -g . # install the project globally

# move to parent dir
cd ..
rm -rf localgit_tmp # remove the temporary folder

# check if localgit is installed successfully
if ! command -v localgit &> /dev/null; then
    echo "Localgit installation error: Cant find command."
    echo " Normally the package is installed in /usr/local/bin/localgit"
    echo "And that bash may not recognise it." 
    echo "Check if its the case."
fi

echo "localgit installation completed successfully!"
echo "run \`localgit\` to setup git server and start the service..."
