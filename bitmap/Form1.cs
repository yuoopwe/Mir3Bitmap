using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Data;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Newtonsoft.Json;

namespace bitmap
{
    public partial class Form1 : Form
    {
        // A* algorithm
        //use map and go in a direction to identify a wall, if there is a wall cannot try that direction again
        // end points and start points
        [DllImport("user32.dll")]
        public static extern int SetActiveWindow(IntPtr hwnd);
        [DllImport("user32.dll")]
        public static extern int SetForegroundWindow(IntPtr hwnd);
        //
        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
        //
        [DllImport("user32.dll")]
        static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        [DllImport("user32.dll", CharSet = CharSet.Auto, CallingConvention = CallingConvention.StdCall)]
        public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint cButtons, uint dwExtraInfo);

        [DllImport("user32.dll", EntryPoint = "SetCursorPos")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetCursorPos(int x, int y);
        //Mouse actions & Fkeys


        private const int MOUSEEVENTF_LEFTDOWN = 0x02;
        private const int MOUSEEVENTF_LEFTUP = 0x04;
        private const int MOUSEEVENTF_RIGHTDOWN = 0x08;
        private const int MOUSEEVENTF_RIGHTUP = 0x10;
        private const int WM_KEYDOWN = 0x0100;
        private const int VK_D = 0x44;

        private const int VK_F1 = 0x70;
        private const int VK_1 = 0x31;
        private const int VK_F2 = 0x71;
        private const int VK_F3 = 0x72;
        private const int VK_F4 = 0x73;
        private const int VK_F5 = 0x74;
        private const int VK_F6 = 0x75;
        private const int VK_F7 = 0x76;
        private const int VK_F8 = 0x77;
        private const int VK_F9 = 0x78;
        private const int VK_F10 = 0x79;
        private const int VK_F11 = 0x7A;
        private const int VK_F12 = 0x7B;



        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;        // x position of upper-left corner
            public int Top;         // y position of upper-left corner
            public int Right;       // x position of lower-right corner
            public int Bottom;      // y position of lower-right corner
        }


        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern IntPtr FindWindowEx(IntPtr parentHandle, IntPtr childAfter, string lclassName, string windowTitle);

        public static IntPtr HWND;
        public static Process OwnerProcess;
        public static RECT RT;
        public Rectangle MyRect = new Rectangle();
        public double MinDistance;
        public PixelLocation MinCoord;
        public RECT rt;
        public Bitmap OverallScreenBitmap;
        public List<Pixelcolor> PixelColorList = new List<Pixelcolor>();
        public List<PixelLocation> MonsterPixelList = new List<PixelLocation>();
        public List<PixelLocation> DungeonPixelList = new List<PixelLocation>();
        public List<PixelLocation> OpenAreaPixelList = new List<PixelLocation>();
        public List<PixelLocation> TraversablePixelList = new List<PixelLocation>();
        public List<Tile> WallTileList = new List<Tile>();


        public List<Tile> ActiveTiles = new List<Tile>();
        public List<Tile> VisitedTiles = new List<Tile>();

        public PixelLocation Character;
        public PixelLocation MapCharacter;
        public PixelLocation PreviousPosition;

        public Bitmap MapBitmap;
        public Bitmap PreviousMap;
        public Tile PreviousTile;

        public PixelLocation MapTopLeftPixel;
        public PixelLocation MapBottomRightPixel;
        public Area PrajnaVillage;
        public Form1()
        {
            InitializeComponent();
            //Find handle & handle info
            HWND = FindWindowEx(IntPtr.Zero, IntPtr.Zero, null, "Legend of Mir III - Xtreme Edition");

            GetWindowRect(HWND, out rt);

            MyRect.X = rt.Left;
            MyRect.Y = rt.Top;
            MyRect.Width = rt.Right - rt.Left;
            MyRect.Height = rt.Bottom - rt.Top;

        }

        private void AttackButton_Click(object sender, EventArgs e)
        {
            List<PixelLocation> pixelList = new List<PixelLocation>();
            //Set stop watches to time buffs/TT
            var stopwatch = new Stopwatch();
            var gameStopwatch = Stopwatch.StartNew();
            gameStopwatch.Start();

          
            bool Isplayed = true;
            int counter = 0;
            do
            {
                MakeBitmap();
                // FindDestinations();
                LockandReadImage(OverallScreenBitmap); // also attacks for now
                if (stopwatch.IsRunning == false || stopwatch.ElapsedMilliseconds > 180000)
                {
                    CastBuffs();
                    UseRT();
                    stopwatch.Restart();
                    stopwatch.Start();

                }
                if (counter % 30 == 0)
                {
                    PickUpItems();
                }
                counter++;
                if (gameStopwatch.ElapsedMilliseconds > 7.2e+6)
                {
                  //  Isplayed = false;
                }



            } while (Isplayed == true);


        }

        private void TravelButton_Click(object sender, EventArgs e)
        {
            bool Isplayed = true;
            int counter = 0;
            UseAutorun();
            do
            {
                
                MakeBitmap();
                FindMap(OverallScreenBitmap);
                MakeMap();
                var newMapCheck = FindCharacterOnMap();
                if (counter == 0)
                {
                    PreviousPosition = MapCharacter;
                    GenerateWallPixelTiles();
                }
                if(newMapCheck == null)
                {
                    MessageBox.Show("You have reached your destination");
                    Isplayed = false;
                    goto end;
                }
                PathingAlgorithm();
                //LockandReadImage(OverallScreenBitmap); // also attacks for now
                counter++;
                 end:;

            } while (Isplayed == true);
        }

        private void TestButton_Click(object sender, EventArgs e)
        {
            MakeBitmap();
            FindMap(OverallScreenBitmap);
            MakeMap();
            FindCharacterOnMap();
            PreviousPosition = MapCharacter;
            GenerateWallPixelTiles();
            FPPathingAlgorithm();

        }

        public void UseAutorun()
        {
            SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_D, IntPtr.Zero);

        }
        public void UseRT()
        {
            SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_1, IntPtr.Zero);

        }
        public void CastBuffs()
        {
            SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F2, IntPtr.Zero);
            System.Threading.Thread.Sleep(1500);
            SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F3, IntPtr.Zero);
            System.Threading.Thread.Sleep(1500);
            SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F4, IntPtr.Zero);
            System.Threading.Thread.Sleep(1500);
            SendMessage(HWND, WM_KEYDOWN, (IntPtr)VK_F5, IntPtr.Zero);

        }
        private void PickUpItems()
        {
            DoMouseClickAttack(MyRect.X + 8 + Character.X, 31 + MyRect.Y + Character.Y);
            DoMouseClickAttack(MyRect.X + 8 + Character.X, 31 + MyRect.Y + Character.Y);
            DoMouseClickAttack(MyRect.X + 8 + Character.X, 31 + MyRect.Y + Character.Y);
            DoMouseClickAttack(MyRect.X + 8 + Character.X, 31 + MyRect.Y + Character.Y);
        }

        public void DoMouseClickAttack(int X, int Y)
        {
            //Call the imported function with the cursor's current position
            SetCursorPos(X, Y);
            //SetForegroundWindow(HWND);
            mouse_event(MOUSEEVENTF_LEFTDOWN, (uint)X, (uint)Y, 0, 0);
            System.Threading.Thread.Sleep(100);
            mouse_event(MOUSEEVENTF_LEFTUP, (uint)X, (uint)Y, 0, 0);

        }

        public void DoMouseClickTravel(int X, int Y)
        {
            //Call the imported function with the cursor's current position
            SetCursorPos(X, Y);
            //SetForegroundWindow(HWND);
           // mouse_event(MOUSEEVENTF_LEFTDOWN, (uint)X, (uint)Y, 0, 0);
            System.Threading.Thread.Sleep(500);
           // mouse_event(MOUSEEVENTF_LEFTUP, (uint)X, (uint)Y, 0, 0);
           // System.Threading.Thread.Sleep(1000);


        }

        public unsafe List<PixelLocation> GenerateWallPixelTiles()
        {
            BitmapData bData = new BitmapData();

            bData = MapBitmap.LockBits(new Rectangle(0, 0, MapBitmap.Width, MapBitmap.Height), ImageLockMode.ReadWrite, MapBitmap.PixelFormat);

            byte bitsPerPixel = (byte)Bitmap.GetPixelFormatSize(bData.PixelFormat);

            /*This time we convert the IntPtr to a ptr*/
            byte* scan0 = (byte*)bData.Scan0.ToPointer();

            //Find Dungeons
            for (int i = 0; i < bData.Height; ++i)
            {
                for (int j = 0; j < bData.Width; ++j)
                {

                    byte* color = scan0 + i * bData.Stride + j * bitsPerPixel / 8;
                    if (color[0] == 0 && color[1] == 0 && color[3] != 8)
                    {
                        TraversablePixelList.Add(new PixelLocation(j, i));
                    }



                }
            }
            MapBitmap.UnlockBits(bData);
            return TraversablePixelList;
        }
        public unsafe void FindDestinations()
        {
            BitmapData bData = new BitmapData();

            bData = MapBitmap.LockBits(new Rectangle(0, 0, MapBitmap.Width, MapBitmap.Height), ImageLockMode.ReadWrite, MapBitmap.PixelFormat);

            byte bitsPerPixel = (byte)Bitmap.GetPixelFormatSize(bData.PixelFormat);

            /*This time we convert the IntPtr to a ptr*/
            byte* scan0 = (byte*)bData.Scan0.ToPointer();

            //Find Dungeons
            for (int i = 0; i < bData.Height - 2; ++i)
            {
                for (int j = 0; j < bData.Width - 2; ++j)
                {


                    // Look for 3 black pixels in a colum next to a white
                    byte* color = scan0 + i * bData.Stride + j * bitsPerPixel / 8;
                    byte* color1 = scan0 + (i + 1) * bData.Stride + j * bitsPerPixel / 8;
                    byte* color2 = scan0 + (i + 2) * bData.Stride + j * bitsPerPixel / 8;

                    if (color[0] == 0 && color[1] == 48 && color[2] == 176 && color1[0] == 0 && color1[1] == 48 && color1[2] == 176 && color2[0] == 0 && color2[1] == 0 && color2[2] == 8)
                    {
                        DungeonPixelList.Add(new PixelLocation(j, i));
                    }

                }
            }

            //Find OpenAreas
            for (int i = 0; i < bData.Height - 2; ++i)
            {
                for (int j = 0; j < bData.Width - 2; ++j)
                {


                    // Look for 3 black pixels in a colum next to a white
                    byte* color = scan0 + i * bData.Stride + j * bitsPerPixel / 8;
                    byte* color1 = scan0 + (i + 1) * bData.Stride + j * bitsPerPixel / 8;
                    byte* color2 = scan0 + (i + 2) * bData.Stride + j * bitsPerPixel / 8;

                    if (color[0] == 140 && color[1] == 128 && color[2] == 119 && color1[0] == 255 && color1[1] == 251 && color1[2] == 239 && color2[0] == 255 && color2[1] == 227 && color2[2] == 206)
                    {
                        OpenAreaPixelList.Add(new PixelLocation(j, i));
                    }

                }
            }
            MapBitmap.UnlockBits(bData);

        }
        public Destination DeserializeMapAndReturnDestination()
        {
            //move to relative path for other computers
            string prajnaVilage = System.IO.File.ReadAllText(@"C:\Users\con16\Desktop\Bitmat bot\bitmap\AreaJsons\PrajnaVillage.Json");
            Area currentArea = JsonConvert.DeserializeObject<Area>(prajnaVilage);
            Destination currentDestination = new Destination();
            foreach (var item in currentArea.Dungeons)
            {
                if (item.Name == "Prajna Cave")
                {
                    currentDestination = item;
                }
            }
            return currentDestination;
        }
        public void MakeBitmap()
        {
            //Create a new bitmap.
            OverallScreenBitmap = new Bitmap(1600, 900);

            // Create a graphics object from the bitmap.
            var gfxScreenshot = Graphics.FromImage(OverallScreenBitmap);

            // Take the screenshot from the upper left corner to the right bottom corner.
            gfxScreenshot.CopyFromScreen(rt.Left + 8,
                                        rt.Top + 31,
                                        0,
                                        0,
                                        new Rectangle(0, 0, 1600, 900).Size,
                                        CopyPixelOperation.SourceCopy);


        }

        public unsafe void FindMap(Bitmap bmpScreenshot)
        {
            MonsterPixelList.Clear();
            BitmapData bData = new BitmapData();

            bData = bmpScreenshot.LockBits(new Rectangle(0, 0, bmpScreenshot.Width, bmpScreenshot.Height), ImageLockMode.ReadWrite, bmpScreenshot.PixelFormat);

            byte bitsPerPixel = (byte)Bitmap.GetPixelFormatSize(bData.PixelFormat);

            byte* scan0 = (byte*)bData.Scan0.ToPointer();

            //Find top left
            for (int i = 0; i < bData.Height / 4 + 200; ++i)
            {
                for (int j = 0; j < bData.Width / 4 + 200; ++j)
                {


                    // Look for 3 black pixels in a colum next to a white
                    byte* color = scan0 + i * bData.Stride + j * bitsPerPixel / 8;
                    byte* color1 = scan0 + i * bData.Stride + (j + 1) * bitsPerPixel / 8;
                    byte* color2 = scan0 + (i + 1) * bData.Stride + j * bitsPerPixel / 8;
                    byte* color3 = scan0 + (i + 1) * bData.Stride + (j + 1) * bitsPerPixel / 8;

                    if (color[0] == 99 && color[1] == 166 && color[2] == 198 && color1[0] == 99 && color1[1] == 166 && color1[2] == 198 && color2[0] == 99 && color2[1] == 166 && color2[2] == 198 && color3[0] == 0 && color3[1] == 0 && color3[2] == 0)
                    {
                        MapTopLeftPixel = new PixelLocation(j, i);
                        goto end;
                    }


                }
            }
            end:
            //Find bottom right
            for (int i = bData.Height / 2; i < bData.Height - 1; ++i)
            {
                for (int j = bData.Width / 2; j < bData.Width - 1; ++j)
                {


                    // Look for 3 black pixels in a colum next to a white
                    byte* color = scan0 + i * bData.Stride + j * bitsPerPixel / 8;
                    byte* color1 = scan0 + i * bData.Stride + (j + 1) * bitsPerPixel / 8;
                    byte* color2 = scan0 + (i + 1) * bData.Stride + j * bitsPerPixel / 8;
                    byte* color3 = scan0 + (i + 1) * bData.Stride + (j + 1) * bitsPerPixel / 8;

                    if (color[0] == 0 && color[1] == 0 && color[2] == 0 && color1[0] == 99 && color1[1] == 166 && color1[2] == 198 && color2[0] == 99 && color2[1] == 166 && color2[2] == 198 && color3[0] == 99 && color3[1] == 166 && color3[2] == 198)
                    {
                        MapBottomRightPixel = new PixelLocation(j, i);
                        goto end1;
                    }

                }
            }
            end1:

            bmpScreenshot.UnlockBits(bData);


        }

        public Bitmap MakeMap()
        {
            MapBitmap = new Bitmap(MapBottomRightPixel.X - MapTopLeftPixel.X, MapBottomRightPixel.Y - MapTopLeftPixel.Y);
            using (Graphics graphics = Graphics.FromImage(MapBitmap))
            {
                Rectangle mapRectangle = new Rectangle(MapTopLeftPixel.X, MapTopLeftPixel.Y, MapBitmap.Width, MapBitmap.Height);
                Rectangle sizeRectangle = new Rectangle(0, 0, MapBitmap.Width, MapBitmap.Height);

                graphics.DrawImage(OverallScreenBitmap, 0, 0, mapRectangle, GraphicsUnit.Pixel);
            }
            return MapBitmap;

        }

        public unsafe PixelLocation FindCharacterOnMap()
        {
            BitmapData bData = new BitmapData();

            bData = MapBitmap.LockBits(new Rectangle(0, 0, MapBitmap.Width, MapBitmap.Height), ImageLockMode.ReadWrite, MapBitmap.PixelFormat);

            byte bitsPerPixel = (byte)Bitmap.GetPixelFormatSize(bData.PixelFormat);

            byte* scan0 = (byte*)bData.Scan0.ToPointer();
            for (int i = 0; i < bData.Height - 1; ++i)
            {
                for (int j = 0; j < bData.Width - 1; ++j)
                {


                    // Look for 3 black pixels in a colum next to a white
                    byte* color = scan0 + i * bData.Stride + j * bitsPerPixel / 8;
                    byte* color1 = scan0 + i * bData.Stride + (j + 1) * bitsPerPixel / 8;
                    byte* color2 = scan0 + i * bData.Stride + (j + 2) * bitsPerPixel / 8;
                    byte* color3 = scan0 + i * bData.Stride + (j + 3) * bitsPerPixel / 8;

                    if (color[0] == 255 && color[1] == 255 && color[2] == 0 && color1[0] == 255 && color1[1] == 255 && color1[2] == 0 && color2[0] == 255 && color2[1] == 255 && color2[2] == 0 && color3[0] == 255 && color3[1] == 255 && color3[2] == 0)
                    {
                        MapCharacter = new PixelLocation(j, i);
                        goto end;
                    }

                    //color is a pointer to the first byte of the 3-byte color data
                    //color[0] = blueComponent;
                    //color[1] = greenComponent;
                    //color[2] = redComponent;

                }
            }
        end:;
            MapBitmap.UnlockBits(bData);
            return MapCharacter;


        }




        public unsafe void LockandReadImage(Bitmap bmpScreenshot)
        {
            MonsterPixelList.Clear();
            BitmapData bData = new BitmapData();

            bData = bmpScreenshot.LockBits(new Rectangle(0, 0, bmpScreenshot.Width, bmpScreenshot.Height), ImageLockMode.ReadWrite, bmpScreenshot.PixelFormat);

            byte bitsPerPixel = (byte)Bitmap.GetPixelFormatSize(bData.PixelFormat);

            byte* scan0 = (byte*)bData.Scan0.ToPointer();

            for (int i = 0; i < bData.Height - 100; ++i)
            {
                for (int j = 0; j < bData.Width - 1; ++j)
                {


                    // Look for 3 black pixels in a colum next to a white
                    byte* color = scan0 + i * bData.Stride + j * bitsPerPixel / 8;
                    byte* color1 = scan0 + (i + 1) * bData.Stride + j * bitsPerPixel / 8;
                    byte* color2 = scan0 + (i + 1) * bData.Stride + j * bitsPerPixel / 8;
                    byte* color3 = scan0 + i * bData.Stride + (j + 1) * bitsPerPixel / 8;

                    if (color[0] == color[1] && color[0] == color[2] && color[0] == 0 && color1[0] == color1[1] && color1[0] == color1[2] && color1[0] == 0 && color2[0] == color2[1] && color2[0] == color2[2] && color2[0] == 0 && color3[0] == color3[1] && color3[0] == color3[2] && color3[0] > 100)
                    {
                        MonsterPixelList.Add(new PixelLocation(j, i));
                    }


                }
            }

            bmpScreenshot.UnlockBits(bData);
            Character = new PixelLocation(bmpScreenshot.Width / 2, bmpScreenshot.Height / 2);
            MinDistance = 100000000;
            foreach (var pixel in MonsterPixelList)
            {
                double dist = Math.Sqrt(Math.Pow(Character.X - pixel.X, 2) + Math.Pow(Character.Y - pixel.Y, 2));
                if (dist < MinDistance && dist > 50)
                {
                    MinDistance = dist;
                    MinCoord = pixel;
                }
            }

            DoMouseClickAttack(MinCoord.X + MyRect.X + 8, MinCoord.Y + MyRect.Y + 31);


        }
        public class Tile
        {
            public int X { get; set; }
            public int Y { get; set; }
            public int Cost { get; set; }
            public int Distance { get; set; }
            public int CostDistance => Cost + Distance;
            public Tile Parent { get; set; }

            //The distance is essentially the estimated distance, ignoring walls to our target. 
            //So how many tiles left and right, up and down, ignoring walls, to get there. 
            public void SetDistance(int targetX, int targetY)
            {
                this.Distance = Math.Abs(targetX - X) + Math.Abs(targetY - Y);
            }
        }
        public void PathingAlgorithm()
        {
            Tile characterTile = new Tile();
            characterTile.X = MapCharacter.X;
            characterTile.Y = MapCharacter.Y;
            var currentDestination = DeserializeMapAndReturnDestination();
            Tile currentDestinationTile = new Tile();
            currentDestinationTile.X = currentDestination.Location.X;
            currentDestinationTile.Y = currentDestination.Location.Y;


            SetStartOfPath(MapCharacter, currentDestination.Location);
            DoAlg(currentDestinationTile, MapBitmap, currentDestination);

        }



        public void DoAlg(Tile finish, Bitmap map, Destination currentDestination)
        {
            //This is where we created the map from our previous step etc. 
            int counter = 0;
            while (ActiveTiles.Any())
            {
                var checkTile = ActiveTiles.OrderBy(x => x.CostDistance).First();
                Tile currentPositionTile = new Tile();
                currentPositionTile = checkTile;
                if (checkTile.X == finish.X && checkTile.Y == finish.Y)
                {

                    return;
                }
                ActiveTiles.Remove(checkTile);
                Movement(checkTile);
                bool successfulMovement = CheckMovementSuccessful(PreviousPosition);
                if (successfulMovement == true)
                {  
                    PreviousTile = checkTile;  
                                        
                }
                VisitedTiles.Add(currentPositionTile);
                if (true)
                {
                    VisitedTilesScan(checkTile);
                }
                PreviousPosition = MapCharacter;
                if (counter == 0)
                {
                    PreviousTile = checkTile;
                    UpdateActiveAndVisitedTiles(checkTile, map, finish, currentDestination, successfulMovement);
                }
                //Try to move and if we fail, update the wall tiles
                if (successfulMovement == false)
                {
                    WallTileList.Add(checkTile);
                }
                else
                {
                    UpdateActiveAndVisitedTiles(checkTile, map, finish, currentDestination, successfulMovement);

                }
                counter++;

            }

            Console.WriteLine("No Path Found!");
        }

        public void VisitedTilesScan(Tile checkTile)
        {
            int x = PreviousPosition.X;
            int y = PreviousPosition.Y;
            Func<int, int> step = PreviousPosition.X < checkTile.X ? (i) => { return ++i; } : (i) => { return --i; };
            Func<int, int> step2 = PreviousPosition.Y < checkTile.Y ? (i2) => { return ++i2; } : (i2) => { return --i2; };



            if (x != checkTile.X && y == checkTile.Y)
            {
                while (x != checkTile.X)
                {
                    VisitedTiles.Add(new Tile { X = x, Y = PreviousPosition.Y, Parent = null, Cost = PreviousTile.Cost });
                    x = step(x);
                }

            }
            else if (x == checkTile.X && y != checkTile.Y)
            {
                while (y != checkTile.Y)
                {
                    VisitedTiles.Add(new Tile { X = PreviousPosition.X, Y = y, Parent = null, Cost = PreviousTile.Cost });
                    y = step2(y);
                }
            }
            else if (x != checkTile.X && y != checkTile.Y)
            {
                for (x = PreviousPosition.X; x != checkTile.X; x = step(x))
                {

                    for (y = PreviousPosition.Y; y != checkTile.Y; y = step2(y))
                    {
                        VisitedTiles.Add(new Tile { X = x, Y = y, Parent = null, Cost = PreviousTile.Cost });

                    }
                }
            }
            else
            {

            }
        }
        public void UpdateActiveAndVisitedTiles(Tile checkTile, Bitmap map, Tile finish, Destination currentDestination, bool successfulMovement)
        {
            ActiveTiles.Clear();
            
            checkTile.X = MapCharacter.X;
            checkTile.Y = MapCharacter.Y;

            var walkableTiles = GetWalkableTiles(map, checkTile, finish, WallTileList, currentDestination.Location);

            foreach (var walkableTile in walkableTiles)
            {
                //We have already visited this tile so we don't need to do so again!
                if (VisitedTiles.Any(x => x.X == walkableTile.X && x.Y == walkableTile.Y))
                    continue;

                //It's already in the active list, but that's OK, maybe this new tile has a better value (e.g. We might zigzag earlier but this is now straighter). 
                if (ActiveTiles.Any(x => x.X == walkableTile.X && x.Y == walkableTile.Y))
                {
                    var existingTile = ActiveTiles.First(x => x.X == walkableTile.X && x.Y == walkableTile.Y);
                    if (existingTile.CostDistance > checkTile.CostDistance)
                    {
                        ActiveTiles.Remove(existingTile);
                        ActiveTiles.Add(walkableTile);

                    }
                }
                else
                {
                    //We've never seen this tile before so add it to the list. 
                    ActiveTiles.Add(walkableTile);
                }
            }
        }

        public bool CheckMovementSuccessful(PixelLocation currentPosition)
        {
            MakeBitmap();
            FindMap(OverallScreenBitmap);
            MakeMap();
            MapCharacter = FindCharacterOnMap();
            if (MapCharacter.X != PreviousPosition.X || MapCharacter.Y != PreviousPosition.Y)
            {
                return true;
            }
            else
            {
                return false;
            }

        }
        public void Movement(Tile checkTile)
        {
            if (checkTile.X - MapCharacter.X > 0 && checkTile.Y - MapCharacter.Y > 0)
            {
                //South East
                DoMouseClickTravel(1348 + MyRect.X + 8, 700 + MyRect.Y + 31);

            }
            else if (checkTile.X - MapCharacter.X < 0 && checkTile.Y - MapCharacter.Y > 0)
            {
                //South West
                DoMouseClickTravel(256 + MyRect.X + 8, 619 + MyRect.Y + 31);

            }
            else if (checkTile.X - MapCharacter.X > 0 && checkTile.Y - MapCharacter.Y < 0)
            {
                //North East
                DoMouseClickTravel(1290 + MyRect.X + 8, 139 + MyRect.Y + 31);

            }
            else if (checkTile.X - MapCharacter.X < 0 && checkTile.Y - MapCharacter.Y < 0)
            {
                //North West
                DoMouseClickTravel(324 + MyRect.X + 8, 121 + MyRect.Y + 31);

            }
            else if (checkTile.X - MapCharacter.X == 0 && checkTile.Y - MapCharacter.Y < 0)
            {
                //North

                DoMouseClickTravel(812 + MyRect.X + 8, 73 + MyRect.Y + 31);

            }
            else if (checkTile.X - MapCharacter.X == 0 && checkTile.Y - MapCharacter.Y > 0)
            {
                //South
                DoMouseClickTravel(809 + MyRect.X + 8, 789 + MyRect.Y + 31);

            }
            else if (checkTile.X - MapCharacter.X > 0 && checkTile.Y - MapCharacter.Y == 0)
            {
                //East
                DoMouseClickTravel(1341 + MyRect.X + 8, 426 + MyRect.Y + 31);

            }
            else if (checkTile.X - MapCharacter.X < 0 && checkTile.Y - MapCharacter.Y == 0)
            {
                //West
                DoMouseClickTravel(232 + MyRect.X + 8, 444 + MyRect.Y + 31);

            }
            else
            {
                // if dont move do nothing
            }
        }

        public void SetStartOfPath(PixelLocation Character, PixelLocation Destination)
        {

            var start = new Tile();
            start.Y = Character.Y;
            start.X = Character.X;

            var finish = new Tile();
            finish.Y = Destination.Y;
            finish.X = Destination.X;

            start.SetDistance(finish.X, finish.Y);
            ActiveTiles.Add(start);
        }
        public List<Tile> GetWalkableTiles(Bitmap map, Tile currentTile, Tile targetTile, List<Tile> WallTileList, PixelLocation Destination)
        {
           
            var possibleTiles = new List<Tile>()
            {
            
            new Tile { X = currentTile.X + 3, Y = currentTile.Y, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X + 3, Y = currentTile.Y + 2, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X, Y = currentTile.Y + 2, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X + 3, Y = currentTile.Y - 2, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X, Y = currentTile.Y- 2, Parent = currentTile, Cost = currentTile.Cost + 1},
            new Tile { X = currentTile.X - 3, Y = currentTile.Y, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X - 3, Y = currentTile.Y + 2, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X - 3, Y = currentTile.Y - 2, Parent = currentTile, Cost = currentTile.Cost + 1 },

            };

            possibleTiles.ForEach(tile => tile.SetDistance(targetTile.X, targetTile.Y));

            var maxX = map.Width;
            var maxY = map.Height;
            List<int> intList = new List<int>();
            intList.Clear();

            return possibleTiles
            .Where(tile => !WallTileList.Any(x => x.X == tile.X && x.Y == tile.Y ))
            .ToList();
        }

        ///////////////////////////////////////////////////////////////////////////
        ///FIRST PASS///////////
        ///////////////////////////////////////////////////////////////////////////

        public void FPPathingAlgorithm()
        {
            Tile characterTile = new Tile();
            characterTile.X = MapCharacter.X;
            characterTile.Y = MapCharacter.Y;
            var currentDestination = DeserializeMapAndReturnDestination();
            Tile currentDestinationTile = new Tile();
            currentDestinationTile.X = currentDestination.Location.X;
            currentDestinationTile.Y = currentDestination.Location.Y;
            var map = GenerateWallPixelTiles();

            FPSetStartOfPath(MapCharacter, currentDestination.Location);
            FPDoAlg(currentDestinationTile, map, currentDestination);

        }
        public void FPSetStartOfPath(PixelLocation Character, PixelLocation Destination)
        {

            var start = new Tile();
            start.Y = Character.Y;
            start.X = Character.X;

            var finish = new Tile();
            finish.Y = Destination.Y;
            finish.X = Destination.X;

            start.SetDistance(finish.X, finish.Y);
            ActiveTiles.Add(start);
        }
        public void FPDoAlg(Tile finish, List<PixelLocation> map, Destination currentDestination)
        {
            //This is where we created the map from our previous step etc. 
            while (ActiveTiles.Any())
            {
                var checkTile = ActiveTiles.OrderBy(x => x.CostDistance).First();

                if (checkTile.X == finish.X && checkTile.Y == finish.Y)
                {
                    List<Tile> OptimalPath = new List<Tile>();
                    var tile = checkTile;
                    while (true)
                    {
                        
                        OptimalPath.Add(tile);
                        tile = tile.Parent;

                        if (tile == null)
                        {
                            
                            return;
                        }
                    }
                    
                }
                bool successfulMovement = true;
                VisitedTiles.Add(checkTile);
                ActiveTiles.Remove(checkTile);
                FPUpdateActiveAndVisitedTiles(checkTile, map, finish, currentDestination, successfulMovement);

            }

            Console.WriteLine("No Path Found!");
        }
        public void FPUpdateActiveAndVisitedTiles(Tile checkTile, List<PixelLocation> map, Tile finish, Destination currentDestination, bool successfulMovement)
        {

            var walkableTiles = FPGetWalkableTiles(map, checkTile, finish, WallTileList, currentDestination.Location);

            foreach (var walkableTile in walkableTiles)
            {
                //We have already visited this tile so we don't need to do so again!
                if (VisitedTiles.Any(x => x.X == walkableTile.X && x.Y == walkableTile.Y))
                    continue;

                //It's already in the active list, but that's OK, maybe this new tile has a better value (e.g. We might zigzag earlier but this is now straighter). 
                if (ActiveTiles.Any(x => x.X == walkableTile.X && x.Y == walkableTile.Y))
                {
                    var existingTile = ActiveTiles.First(x => x.X == walkableTile.X && x.Y == walkableTile.Y);
                    if (existingTile.CostDistance > checkTile.CostDistance)
                    {
                        ActiveTiles.Remove(existingTile);
                        ActiveTiles.Add(walkableTile);

                    }
                }
                else
                {
                    //We've never seen this tile before so add it to the list. 
                    ActiveTiles.Add(walkableTile);
                }
            }
        }
        public List<Tile> FPGetWalkableTiles(List<PixelLocation> map, Tile currentTile, Tile targetTile, List<Tile> WallTileList, PixelLocation Destination)
        {
            var possibleTiles = new List<Tile>()
            {
            new Tile { X = currentTile.X + 1, Y = currentTile.Y, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X + 1, Y = currentTile.Y + 1, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X, Y = currentTile.Y + 1, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X + 1, Y = currentTile.Y - 1, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X, Y = currentTile.Y- 1, Parent = currentTile, Cost = currentTile.Cost + 1},
            new Tile { X = currentTile.X - 1, Y = currentTile.Y, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X - 1, Y = currentTile.Y + 1, Parent = currentTile, Cost = currentTile.Cost + 1 },
            new Tile { X = currentTile.X - 1, Y = currentTile.Y - 1, Parent = currentTile, Cost = currentTile.Cost + 1 },

            };

            possibleTiles.ForEach(tile => tile.SetDistance(targetTile.X, targetTile.Y));

            var maxX = MapBitmap.Width;
            var maxY = MapBitmap.Height;

            return possibleTiles
            .Where(tile => tile.X >= 0 && tile.X <= maxX)
            .Where(tile => tile.Y >= 0 && tile.Y <= maxY)
            .Where(tile => !WallTileList.Contains(tile))
            .ToList();
        }
    }









    public class PixelLocation
    {
        public PixelLocation(int x, int y)
        {
            X = x;
            Y = y;
        }

        public int X { get; set; }
        public int Y { get; set; }
    }

    public class Pixelcolor
    {
        public Pixelcolor(byte b, byte g, byte r)
        {
            B = b;
            G = g;
            R = r;
        }

        public byte B { get; set; }
        public byte G { get; set; }
        public byte R { get; set; }
    }


}
