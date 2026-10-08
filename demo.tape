# Renders demo.gif with https://github.com/charmbracelet/vhs — run `vhs demo.tape` in a project with a Claude Code setup.
Output demo.gif
Set FontSize 15
Set Width 1100
Set Height 700
Set Theme "Catppuccin Latte"
Type "npx ccpack" Sleep 300ms Enter
Sleep 2s
Enter
Sleep 5s
Enter
Sleep 1s
Type "npx ccpack inspect ../$(basename $PWD).ccpack.tar.gz" Sleep 300ms Enter
Sleep 4s
